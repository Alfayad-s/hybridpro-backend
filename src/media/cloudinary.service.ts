import { BadRequestException, Injectable, ServiceUnavailableException } from '@nestjs/common';
import { Readable } from 'node:stream';
import { v2 as cloudinary } from 'cloudinary';

export type ExerciseMediaKind = 'image' | 'video';

@Injectable()
export class CloudinaryService {
  private configured = false;

  private ensureConfigured() {
    if (this.configured) return;
    const cloudName =
      process.env.CLOUDINARY_CLOUD_NAME ||
      process.env.CLOUD_NAME ||
      process.env.NEXT_PUBLIC_CLOUDINARY_CLOUD_NAME;
    const apiKey = process.env.CLOUDINARY_API_KEY;
    const apiSecret = process.env.CLOUDINARY_API_SECRET;

    if (!cloudName || !apiKey || !apiSecret) {
      throw new ServiceUnavailableException(
        'Cloudinary is not configured. Set CLOUD_NAME/CLOUDINARY_CLOUD_NAME, CLOUDINARY_API_KEY, and CLOUDINARY_API_SECRET.',
      );
    }

    cloudinary.config({
      cloud_name: cloudName,
      api_key: apiKey,
      api_secret: apiSecret,
      secure: true,
    });
    this.configured = true;
  }

  private uploadBuffer(
    buffer: Buffer,
    options: Record<string, unknown>,
  ): Promise<{ secure_url: string; public_id: string }> {
    this.ensureConfigured();
    return new Promise((resolve, reject) => {
      const stream = cloudinary.uploader.upload_stream(options, (err, result) => {
        if (err || !result?.secure_url) {
          reject(err ?? new Error('Cloudinary upload failed'));
          return;
        }
        resolve({ secure_url: result.secure_url, public_id: result.public_id });
      });
      Readable.from(buffer).pipe(stream);
    });
  }

  async uploadExerciseMedia(params: {
    coachKey: string;
    exerciseKey: string;
    buffer: Buffer;
    kind: ExerciseMediaKind;
  }): Promise<{ url: string; publicId: string; kind: ExerciseMediaKind }> {
    const folder = `gymtrack/exercises/coach-${params.coachKey}`;
    const publicId = `${params.exerciseKey}-${params.kind}`;

    try {
      if (params.kind === 'image') {
        const result = await this.uploadBuffer(params.buffer, {
          folder,
          public_id: publicId,
          overwrite: true,
          invalidate: true,
          resource_type: 'image',
          transformation: [{ width: 1200, height: 1200, crop: 'limit', quality: 'auto' }],
        });
        return { url: result.secure_url, publicId: result.public_id, kind: 'image' };
      }

      const result = await this.uploadBuffer(params.buffer, {
        folder,
        public_id: publicId,
        overwrite: true,
        invalidate: true,
        resource_type: 'video',
      });
      return { url: result.secure_url, publicId: result.public_id, kind: 'video' };
    } catch (error) {
      if (error instanceof ServiceUnavailableException) throw error;
      console.error('[cloudinary.exercise]', error);
      throw new BadRequestException(`Failed to upload ${params.kind}`);
    }
  }

  async uploadChatImage(params: {
    memberUserId: string;
    buffer: Buffer;
    video?: boolean;
  }): Promise<{ url: string; publicId: string }> {
    const safeId = params.memberUserId.replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 48) || 'member';
    const folder = `gymtrack/chat/member-${safeId}`;
    const publicId = `msg-${Date.now().toString(36)}`;

    try {
      const result = await this.uploadBuffer(params.buffer, {
        folder,
        public_id: publicId,
        overwrite: false,
        resource_type: params.video ? 'video' : 'image',
        ...(params.video
          ? {}
          : {
              transformation: [
                { width: 1600, height: 1600, crop: 'limit', quality: 'auto' },
              ],
            }),
      });
      return { url: result.secure_url, publicId: result.public_id };
    } catch (error) {
      if (error instanceof ServiceUnavailableException) throw error;
      console.error('[cloudinary.chat]', error);
      throw new BadRequestException('Failed to upload chat image');
    }
  }

  async uploadStoreImage(params: {
    buffer: Buffer;
  }): Promise<{ url: string; publicId: string }> {
    const folder = 'gymtrack/store/products';
    const publicId = `product-${Date.now().toString(36)}`;

    try {
      const result = await this.uploadBuffer(params.buffer, {
        folder,
        public_id: publicId,
        overwrite: false,
        resource_type: 'image',
        transformation: [{ width: 1600, height: 1600, crop: 'limit', quality: 'auto' }],
      });
      return { url: result.secure_url, publicId: result.public_id };
    } catch (error) {
      if (error instanceof ServiceUnavailableException) throw error;
      console.error('[cloudinary.store]', error);
      throw new BadRequestException('Failed to upload product image');
    }
  }

  async uploadProgressPhoto(params: {
    memberUserId: string;
    buffer: Buffer;
    pose: string;
    day: string;
  }): Promise<{ publicId: string }> {
    const safeId = params.memberUserId.replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 48) || 'member';
    const folder = `gymtrack/progress/member-${safeId}`;
    const publicId = `${params.pose}-${params.day}-${Date.now().toString(36)}`;

    try {
      const result = await this.uploadBuffer(params.buffer, {
        folder,
        public_id: publicId,
        overwrite: false,
        resource_type: 'image',
        type: 'authenticated',
        transformation: [{ width: 1600, height: 2000, crop: 'limit', quality: 'auto' }],
      });
      return { publicId: result.public_id };
    } catch (error) {
      if (error instanceof ServiceUnavailableException) throw error;
      console.error('[cloudinary.progress]', error);
      throw new BadRequestException('Failed to upload progress photo');
    }
  }

  signProgressPhoto(publicId: string): string {
    this.ensureConfigured();
    return cloudinary.url(publicId, {
      type: 'authenticated',
      sign_url: true,
      secure: true,
      resource_type: 'image',
      expires_at: Math.floor(Date.now() / 1000) + 60 * 60,
    });
  }

  async destroyProgressPhoto(publicId: string): Promise<void> {
    this.ensureConfigured();
    try {
      await cloudinary.uploader.destroy(publicId, {
        type: 'authenticated',
        resource_type: 'image',
        invalidate: true,
      });
    } catch (error) {
      console.error('[cloudinary.progress.destroy]', error);
    }
  }
}
