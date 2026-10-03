import { Injectable } from '@nestjs/common';
import { verify, X509Certificate } from 'crypto';
import { isPricingPlanId, type PricingPlanId } from '../plans.js';

/** Apple Root CA - G3. StoreKit 2 transaction signatures chain to this root. */
const APPLE_ROOT_G3 = `-----BEGIN CERTIFICATE-----
MIICQzCCAcmgAwIBAgIILcX8iNLFS5UwCgYIKoZIzj0EAwMwZzEbMBkGA1UEAwwS
QXBwbGUgUm9vdCBDQSAtIEczMSYwJAYDVQQLDB1BcHBsZSBDZXJ0aWZpY2F0aW9u
IEF1dGhvcml0eTETMBEGA1UECgwKQXBwbGUgSW5jLjELMAkGA1UEBhMCVVMwHhcN
MTQwNDMwMTgxOTA2WhcNMzkwNDMwMTgxOTA2WjBnMRswGQYDVQQDDBJBcHBsZSBS
b290IENBIC0gRzMxJjAkBgNVBAsMHUFwcGxlIENlcnRpZmljYXRpb24gQXV0aG9y
aXR5MRMwEQYDVQQKDApBcHBsZSBJbmMuMQswCQYDVQQGEwJVUzB2MBAGByqGSM49
AgEGBSuBBAAiA2IABJjpLz1AcqTtkyJygRMc3RCV8cWjTnHcFBbZDuWmBSp3ZHtf
TjjTuxxEtX/1H7YyYl3J6YRbTzBPEVoA/VhYDKX1DyxNB0cTddqXl5dvMVztK517
IDvYuVTZXpmkOlEKMaNCMEAwHQYDVR0OBBYEFLuw3qFYM4iapIqZ3r6966/ayySr
MA8GA1UdEwEB/wQFMAMBAf8wDgYDVR0PAQH/BAQDAgEGMAoGCCqGSM49BAMDA2gA
MGUCMQCD6cHEFl4aXTQY2e3v9GwOAEZLuN+yRhHFD/3meoyhpmvOwgPUnPWTxnS4
at+qIxUCMG1mihDK1A3UT82NQz60imOlM27jbdoXt2QfyFMm+YhidDkLF1vLUagM
6BgD56KyKA==
-----END CERTIFICATE-----`;

const APPLE_ROOT_G3_FINGERPRINT =
  '63:34:3A:BF:B8:9A:6A:03:EB:B5:7E:9B:3F:5F:A7:BE:7C:4F:5C:75:6F:30:17:B3:A8:C4:88:C3:65:3E:91:79';

export type ApplePurchase = {
  transactionId: string;
  productId: string;
  planId: PricingPlanId;
  expiresAt: Date;
};

type SignedTransaction = {
  transactionId?: string;
  bundleId?: string;
  productId?: string;
  expiresDate?: number;
  revocationDate?: number;
};

/** App Store product ids are the plan ids, or `<bundle>.<plan>`. */
export function planIdForStoreProduct(productId: string): PricingPlanId | null {
  const tail = productId.trim().toLowerCase().split('.').pop() || '';
  return isPricingPlanId(tail) ? tail : null;
}

@Injectable()
export class AppStoreBillingService {
  bundleId() {
    return (process.env.APPLE_BUNDLE_ID || 'in.hybridpro.hybridProApp').trim();
  }

  verifySubscription(signedTransaction: string): ApplePurchase {
    const payload = verifySignedTransaction(signedTransaction);
    if (payload.bundleId !== this.bundleId()) {
      throw new Error('This purchase is for a different app');
    }
    if (payload.revocationDate) {
      throw new Error('This App Store subscription was revoked');
    }
    const planId = planIdForStoreProduct(payload.productId || '');
    const transactionId = payload.transactionId?.trim() || '';
    const expiresAt = payload.expiresDate ? new Date(payload.expiresDate) : null;
    if (!planId || !transactionId || !expiresAt || Number.isNaN(expiresAt.getTime())) {
      throw new Error('This App Store subscription could not be read');
    }
    if (expiresAt.getTime() <= Date.now()) {
      throw new Error('This App Store subscription is not active');
    }
    return {
      transactionId,
      productId: payload.productId || planId,
      planId,
      expiresAt,
    };
  }
}

export function verifySignedTransaction(jws: string): SignedTransaction {
  const parts = jws.trim().split('.');
  if (parts.length !== 3) throw new Error('App Store purchase is invalid');
  const [encodedHeader, encodedPayload, encodedSignature] = parts;
  const header = decodeJson(encodedHeader) as { alg?: string; x5c?: string[] };
  if (header.alg !== 'ES256' || !header.x5c?.length) {
    throw new Error('App Store purchase is invalid');
  }

  const certs = header.x5c.map((der) => new X509Certificate(derToPem(der)));
  assertAppleChain(certs);

  const signatureOk = verify(
    'sha256',
    Buffer.from(`${encodedHeader}.${encodedPayload}`),
    { key: certs[0].publicKey, dsaEncoding: 'ieee-p1363' },
    Buffer.from(encodedSignature, 'base64url'),
  );
  if (!signatureOk) throw new Error('App Store purchase could not be verified');

  return decodeJson(encodedPayload) as SignedTransaction;
}

function assertAppleChain(certs: X509Certificate[]) {
  const root = new X509Certificate(APPLE_ROOT_G3);
  const now = Date.now();
  for (const cert of certs) {
    const from = Date.parse(cert.validFrom);
    const to = Date.parse(cert.validTo);
    if (Number.isNaN(from) || Number.isNaN(to) || from > now || to < now) {
      throw new Error('App Store purchase certificate is expired');
    }
  }
  for (let i = 0; i < certs.length - 1; i += 1) {
    if (!certs[i].verify(certs[i + 1].publicKey)) {
      throw new Error('App Store purchase could not be verified');
    }
  }
  const top = certs[certs.length - 1];
  const pinned = top.fingerprint256 === APPLE_ROOT_G3_FINGERPRINT;
  if (!pinned && !top.verify(root.publicKey)) {
    throw new Error('App Store purchase could not be verified');
  }
}

function derToPem(der: string) {
  const body = der.replace(/[^A-Za-z0-9+/=]/g, '');
  const lines = body.match(/.{1,64}/g)?.join('\n') ?? body;
  return `-----BEGIN CERTIFICATE-----\n${lines}\n-----END CERTIFICATE-----`;
}

function decodeJson(segment: string) {
  try {
    return JSON.parse(Buffer.from(segment, 'base64url').toString('utf8')) as unknown;
  } catch {
    throw new Error('App Store purchase is invalid');
  }
}
