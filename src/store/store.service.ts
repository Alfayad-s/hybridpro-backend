import {
  BadRequestException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { and, asc, count, desc, eq, ilike, inArray, or } from 'drizzle-orm';
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import { DB } from '../db/db.module.js';
import {
  coinRedemptions,
  shopOrders,
  shopPromos,
  storeCategories,
  storeKinds,
  storeProducts,
} from '../db/schema.js';
import { MailService } from '../auth/mail.service.js';
import { WalletService } from '../rewards/wallet.service.js';
import { STORE_SEED_PRODUCTS } from './store-seed.js';

type Db = PostgresJsDatabase<typeof import('../db/schema.js')>;

/** Plans first, then merch categories. */
const CATEGORY_SEED = [
  { slug: 'plans', label: 'Plans', sortOrder: 0 },
  { slug: 'ebooks', label: 'E-Books', sortOrder: 30 },
] as const;

const RETIRED_CATEGORIES = ['tees', 'shorts'] as const;

/** Plan kind first. */
const KIND_SEED = [
  { slug: 'plan', label: 'Plan', sortOrder: 0 },
  { slug: 'merch', label: 'Merch', sortOrder: 10 },
] as const;

const PROMO_SEED = [
  {
    placement: 'banner',
    imageUrl: '/shop/banner-guides-offer.jpg',
    alt: 'Hybrid Pro e-books from ₹599',
    label: 'E-Books',
    category: 'ebooks',
    sortOrder: 0,
  },
  {
    placement: 'banner',
    imageUrl: '/shop/banner-guides-light.jpg',
    alt: 'Hybrid Pro playbook from ₹599',
    label: 'E-Books',
    category: 'ebooks',
    sortOrder: 1,
  },
  {
    placement: 'card',
    imageUrl: '/shop/masonry-guides-offer.jpg',
    alt: 'E-Books from ₹599',
    label: '',
    category: 'ebooks',
    sortOrder: 0,
  },
] as const;

export type StoreTaxonomyDto = {
  id: string;
  slug: string;
  label: string;
  sortOrder: number;
  active: boolean;
  comingSoon: boolean;
  createdAt: string;
  updatedAt: string;
};

export type StoreTaxonomyInput = {
  slug?: string;
  label?: string;
  sortOrder?: number;
  active?: boolean;
  comingSoon?: boolean;
};

export type StoreProductDto = {
  id: string;
  slug: string;
  title: string;
  subtitle: string;
  description: string | null;
  category: string;
  kind: string;
  priceLabel: string;
  pricePaise: number | null;
  coinPrice: number | null;
  imageUrl: string | null;
  sizes: string[];
  planId: string | null;
  active: boolean;
  comingSoon: boolean;
  sortOrder: number;
  createdAt: string;
  updatedAt: string;
};

export type ShopPromoDto = {
  id: string;
  placement: 'banner' | 'card';
  imageUrl: string;
  alt: string;
  label: string;
  category: string;
  active: boolean;
  sortOrder: number;
  createdAt: string;
  updatedAt: string;
};

export type ShopPromoInput = {
  placement?: string;
  imageUrl?: string | null;
  alt?: string;
  label?: string;
  category?: string;
  active?: boolean;
  sortOrder?: number;
};

export type StoreProductInput = {
  title?: string;
  slug?: string;
  subtitle?: string;
  description?: string | null;
  category?: string;
  kind?: string;
  priceLabel?: string;
  pricePaise?: number | null;
  coinPrice?: number | null;
  imageUrl?: string | null;
  sizes?: string[] | string;
  planId?: string | null;
  active?: boolean;
  comingSoon?: boolean;
  sortOrder?: number;
};

@Injectable()
export class StoreService {
  private seeding: Promise<void> | null = null;

  constructor(
    @Inject(DB) private readonly db: Db,
    private readonly wallet: WalletService,
    private readonly mail: MailService,
  ) {}

  // ─── Categories ─────────────────────────────────────────────

  async listCategories(opts?: { activeOnly?: boolean }) {
    await this.ensureSeeded();
    const rows = opts?.activeOnly
      ? await this.db
          .select()
          .from(storeCategories)
          .where(eq(storeCategories.active, true))
          .orderBy(asc(storeCategories.sortOrder), asc(storeCategories.label))
      : await this.db
          .select()
          .from(storeCategories)
          .orderBy(asc(storeCategories.sortOrder), asc(storeCategories.label));
    return { categories: rows.map((r) => this.toTaxonomyDto(r)) };
  }

  async createCategory(input: StoreTaxonomyInput) {
    await this.ensureSeeded();
    const payload = {
      ...this.toTaxonomyRow(input, true),
      comingSoon: Boolean(input.comingSoon),
    };
    const [clash] = await this.db
      .select({ id: storeCategories.id })
      .from(storeCategories)
      .where(eq(storeCategories.slug, payload.slug))
      .limit(1);
    if (clash) throw new BadRequestException(`Category “${payload.slug}” exists`);
    const [row] = await this.db.insert(storeCategories).values(payload).returning();
    return { category: this.toTaxonomyDto(row!) };
  }

  async updateCategory(id: string, input: StoreTaxonomyInput) {
    await this.ensureSeeded();
    const [current] = await this.db
      .select()
      .from(storeCategories)
      .where(eq(storeCategories.id, id))
      .limit(1);
    if (!current) throw new NotFoundException('Category not found');
    const payload = {
      ...this.toTaxonomyRow(input, false, current),
      comingSoon:
        input.comingSoon !== undefined
          ? Boolean(input.comingSoon)
          : current.comingSoon,
    };
    if (payload.slug !== current.slug) {
      const [clash] = await this.db
        .select({ id: storeCategories.id })
        .from(storeCategories)
        .where(eq(storeCategories.slug, payload.slug))
        .limit(1);
      if (clash) throw new BadRequestException(`Category “${payload.slug}” exists`);
      await this.db
        .update(storeProducts)
        .set({ category: payload.slug, updatedAt: new Date() })
        .where(eq(storeProducts.category, current.slug));
    }
    const [row] = await this.db
      .update(storeCategories)
      .set({ ...payload, updatedAt: new Date() })
      .where(eq(storeCategories.id, id))
      .returning();
    return { category: this.toTaxonomyDto(row!) };
  }

  async removeCategory(id: string) {
    await this.ensureSeeded();
    const [current] = await this.db
      .select()
      .from(storeCategories)
      .where(eq(storeCategories.id, id))
      .limit(1);
    if (!current) throw new NotFoundException('Category not found');
    if (current.slug === 'plans') {
      throw new BadRequestException('Cannot delete system category “plans”');
    }
    const [used] = await this.db
      .select({ n: count() })
      .from(storeProducts)
      .where(eq(storeProducts.category, current.slug));
    if ((used?.n ?? 0) > 0) {
      throw new BadRequestException(
        `Cannot delete “${current.label}” — ${used!.n} product(s) still use it`,
      );
    }
    await this.db.delete(storeCategories).where(eq(storeCategories.id, id));
    return { ok: true as const };
  }

  // ─── Kinds ──────────────────────────────────────────────────

  async listKinds(opts?: { activeOnly?: boolean }) {
    await this.ensureSeeded();
    const rows = opts?.activeOnly
      ? await this.db
          .select()
          .from(storeKinds)
          .where(eq(storeKinds.active, true))
          .orderBy(asc(storeKinds.sortOrder), asc(storeKinds.label))
      : await this.db
          .select()
          .from(storeKinds)
          .orderBy(asc(storeKinds.sortOrder), asc(storeKinds.label));
    return { kinds: rows.map((r) => this.toTaxonomyDto(r)) };
  }

  async createKind(input: StoreTaxonomyInput) {
    await this.ensureSeeded();
    const payload = this.toTaxonomyRow(input, true);
    const [clash] = await this.db
      .select({ id: storeKinds.id })
      .from(storeKinds)
      .where(eq(storeKinds.slug, payload.slug))
      .limit(1);
    if (clash) throw new BadRequestException(`Kind “${payload.slug}” exists`);
    const [row] = await this.db.insert(storeKinds).values(payload).returning();
    return { kind: this.toTaxonomyDto(row!) };
  }

  async updateKind(id: string, input: StoreTaxonomyInput) {
    await this.ensureSeeded();
    const [current] = await this.db
      .select()
      .from(storeKinds)
      .where(eq(storeKinds.id, id))
      .limit(1);
    if (!current) throw new NotFoundException('Kind not found');
    const payload = this.toTaxonomyRow(input, false, current);
    if (payload.slug !== current.slug) {
      const [clash] = await this.db
        .select({ id: storeKinds.id })
        .from(storeKinds)
        .where(eq(storeKinds.slug, payload.slug))
        .limit(1);
      if (clash) throw new BadRequestException(`Kind “${payload.slug}” exists`);
      await this.db
        .update(storeProducts)
        .set({ kind: payload.slug, updatedAt: new Date() })
        .where(eq(storeProducts.kind, current.slug));
    }
    const [row] = await this.db
      .update(storeKinds)
      .set({ ...payload, updatedAt: new Date() })
      .where(eq(storeKinds.id, id))
      .returning();
    return { kind: this.toTaxonomyDto(row!) };
  }

  async removeKind(id: string) {
    await this.ensureSeeded();
    const [current] = await this.db
      .select()
      .from(storeKinds)
      .where(eq(storeKinds.id, id))
      .limit(1);
    if (!current) throw new NotFoundException('Kind not found');
    if (current.slug === 'plan' || current.slug === 'merch') {
      throw new BadRequestException(
        `Cannot delete system kind “${current.slug}”`,
      );
    }
    const [used] = await this.db
      .select({ n: count() })
      .from(storeProducts)
      .where(eq(storeProducts.kind, current.slug));
    if ((used?.n ?? 0) > 0) {
      throw new BadRequestException(
        `Cannot delete “${current.label}” — ${used!.n} product(s) still use it`,
      );
    }
    await this.db.delete(storeKinds).where(eq(storeKinds.id, id));
    return { ok: true as const };
  }

  // ─── Products ───────────────────────────────────────────────

  async listAdmin(q?: string, category?: string) {
    await this.ensureSeeded();
    const query = q?.trim();
    const cat = category?.trim().toLowerCase();
    const filters = [];
    if (query) {
      filters.push(
        or(
          ilike(storeProducts.title, `%${query}%`),
          ilike(storeProducts.slug, `%${query}%`),
          ilike(storeProducts.subtitle, `%${query}%`),
          ilike(storeProducts.category, `%${query}%`),
        )!,
      );
    }
    if (cat) filters.push(eq(storeProducts.category, cat));
    const rows =
      filters.length > 0
        ? await this.db
            .select()
            .from(storeProducts)
            .where(and(...filters))
            .orderBy(asc(storeProducts.sortOrder), asc(storeProducts.title))
        : await this.db
            .select()
            .from(storeProducts)
            .orderBy(asc(storeProducts.sortOrder), asc(storeProducts.title));
    return { products: rows.map((row) => this.toProductDto(row)) };
  }

  async listMember(q?: string, category?: string) {
    await this.ensureSeeded();
    const query = q?.trim();
    const cat = category?.trim().toLowerCase();
    const filters = [eq(storeProducts.active, true)];
    if (query) {
      filters.push(
        or(
          ilike(storeProducts.title, `%${query}%`),
          ilike(storeProducts.subtitle, `%${query}%`),
          ilike(storeProducts.category, `%${query}%`),
        )!,
      );
    }
    if (cat) filters.push(eq(storeProducts.category, cat));
    const rows = await this.db
      .select()
      .from(storeProducts)
      .where(and(...filters))
      .orderBy(asc(storeProducts.sortOrder), asc(storeProducts.title));
    return { products: rows.map((row) => this.toProductDto(row)) };
  }

  /** Public website shop: active merch only. Coaching plans stay on /pricing. */
  async listShop() {
    await this.ensureSeeded();
    const rows = await this.db
      .select()
      .from(storeProducts)
      .where(and(eq(storeProducts.active, true), eq(storeProducts.kind, 'merch')))
      .orderBy(asc(storeProducts.sortOrder), asc(storeProducts.title));
    const categories = await this.db
      .select()
      .from(storeCategories)
      .where(eq(storeCategories.active, true))
      .orderBy(asc(storeCategories.sortOrder), asc(storeCategories.label));
    const comingSoonSlugs = new Set(
      categories.filter((category) => category.comingSoon).map((category) => category.slug),
    );
    const visibleRows = rows.filter((row) => !comingSoonSlugs.has(row.category));
    const promos = await this.db
      .select()
      .from(shopPromos)
      .where(eq(shopPromos.active, true))
      .orderBy(asc(shopPromos.sortOrder), asc(shopPromos.createdAt));
    const toPublic = (row: typeof shopPromos.$inferSelect) => ({
      id: row.id,
      image: row.imageUrl,
      alt: row.alt,
      label: row.label,
      category: row.category,
    });
    return {
      categories: categories
        .filter((category) => category.slug !== 'plans')
        .map((category) => ({
          slug: category.slug,
          label: category.label,
          comingSoon: category.comingSoon,
        })),
      products: visibleRows.map((row) => this.toShopProduct(row)),
      banners: promos.filter((row) => row.placement === 'banner').map(toPublic),
      cardPromos: promos.filter((row) => row.placement === 'card').map(toPublic),
    };
  }

  async getShopProduct(slug: string) {
    await this.ensureSeeded();
    const [row] = await this.db
      .select()
      .from(storeProducts)
      .where(
        and(
          eq(storeProducts.slug, slug.trim()),
          eq(storeProducts.active, true),
          eq(storeProducts.kind, 'merch'),
        ),
      )
      .limit(1);
    if (!row) return null;
    const [category] = await this.db
      .select({ comingSoon: storeCategories.comingSoon })
      .from(storeCategories)
      .where(eq(storeCategories.slug, row.category))
      .limit(1);
    const product = this.toShopProduct(row);
    if (category?.comingSoon) product.comingSoon = true;
    return product;
  }

  async create(input: StoreProductInput) {
    await this.ensureSeeded();
    const payload = await this.toProductRow(input, true);
    const [existing] = await this.db
      .select({ id: storeProducts.id })
      .from(storeProducts)
      .where(eq(storeProducts.slug, payload.slug))
      .limit(1);
    if (existing) {
      throw new BadRequestException(`Slug “${payload.slug}” is already used`);
    }
    const [row] = await this.db.insert(storeProducts).values(payload).returning();
    return { product: this.toProductDto(row!) };
  }

  async update(id: string, input: StoreProductInput) {
    await this.ensureSeeded();
    const [current] = await this.db
      .select()
      .from(storeProducts)
      .where(eq(storeProducts.id, id))
      .limit(1);
    if (!current) throw new NotFoundException('Product not found');

    const payload = await this.toProductRow(input, false, current);
    if (payload.slug !== current.slug) {
      const [clash] = await this.db
        .select({ id: storeProducts.id })
        .from(storeProducts)
        .where(eq(storeProducts.slug, payload.slug))
        .limit(1);
      if (clash) {
        throw new BadRequestException(`Slug “${payload.slug}” is already used`);
      }
    }

    const [row] = await this.db
      .update(storeProducts)
      .set({ ...payload, updatedAt: new Date() })
      .where(eq(storeProducts.id, id))
      .returning();
    return { product: this.toProductDto(row!) };
  }

  async listPromos(placement?: string) {
    await this.ensureSeeded();
    const spot = this.parsePlacement(placement, false);
    const rows = spot
      ? await this.db
          .select()
          .from(shopPromos)
          .where(eq(shopPromos.placement, spot))
          .orderBy(asc(shopPromos.sortOrder), asc(shopPromos.createdAt))
      : await this.db
          .select()
          .from(shopPromos)
          .orderBy(asc(shopPromos.sortOrder), asc(shopPromos.createdAt));
    return { promos: rows.map((row) => this.toPromoDto(row)) };
  }

  async createPromo(input: ShopPromoInput) {
    await this.ensureSeeded();
    const payload = await this.toPromoRow(input, true);
    const [row] = await this.db.insert(shopPromos).values(payload).returning();
    return { promo: this.toPromoDto(row!) };
  }

  async updatePromo(id: string, input: ShopPromoInput) {
    await this.ensureSeeded();
    const [current] = await this.db
      .select()
      .from(shopPromos)
      .where(eq(shopPromos.id, id))
      .limit(1);
    if (!current) throw new NotFoundException('Promo not found');
    const payload = await this.toPromoRow(input, false, current);
    const [row] = await this.db
      .update(shopPromos)
      .set({ ...payload, updatedAt: new Date() })
      .where(eq(shopPromos.id, id))
      .returning();
    return { promo: this.toPromoDto(row!) };
  }

  async createShopOrder(input: {
    reference?: string;
    pineOrderId?: string;
    customerName?: string;
    email?: string;
    mobile?: string;
    floor?: string;
    address?: string;
    city?: string;
    pincode?: string;
    items?: {
      slug?: string;
      title?: string;
      size?: string;
      qty?: number;
      paise?: number;
      unitPaise?: number;
      image?: string;
      stockOut?: boolean;
    }[];
    amountPaise?: number;
  }) {
    const reference = input.reference?.trim() || '';
    const email = input.email?.trim() || '';
    if (!reference || !email.includes('@')) {
      throw new BadRequestException('Order reference and email are required');
    }
    const items = this.normalizeOrderItems(input.items ?? []);
    const amountPaise = Math.max(0, Math.floor(Number(input.amountPaise) || 0));
    const payload = {
      reference,
      pineOrderId: input.pineOrderId?.trim() || '',
      status: 'pending',
      customerName: input.customerName?.trim() || '',
      email,
      mobile: (input.mobile || '').replace(/\D/g, '').slice(-10),
      floor: input.floor?.trim() || '',
      address: input.address?.trim() || '',
      city: input.city?.trim() || '',
      pincode: (input.pincode || '').replace(/\D/g, '').slice(0, 6),
      itemsJson: JSON.stringify(items),
      amountPaise: this.orderTotal(items) || amountPaise,
      updatedAt: new Date(),
    };
    const [row] = await this.db
      .insert(shopOrders)
      .values(payload)
      .onConflictDoUpdate({
        target: shopOrders.reference,
        set: payload,
      })
      .returning();
    return { order: await this.toShopOrderDto(row!) };
  }

  async markShopOrderPaid(reference: string, pineOrderId?: string) {
    const ref = reference.trim();
    if (!ref) throw new BadRequestException('Order reference is required');
    const [current] = await this.db
      .select()
      .from(shopOrders)
      .where(eq(shopOrders.reference, ref))
      .limit(1);
    if (!current) throw new NotFoundException('Order not found');
    if (current.status === 'accepted' || current.status === 'rejected') {
      return { order: await this.toShopOrderDto(current) };
    }
    const [row] = await this.db
      .update(shopOrders)
      .set({
        status: 'paid',
        pineOrderId: pineOrderId?.trim() || current.pineOrderId,
        updatedAt: new Date(),
      })
      .where(eq(shopOrders.id, current.id))
      .returning();
    return { order: await this.toShopOrderDto(row!) };
  }

  async updateShopOrder(
    id: string,
    items: {
      slug?: string;
      title?: string;
      size?: string;
      qty?: number;
      paise?: number;
      unitPaise?: number;
      image?: string;
      stockOut?: boolean;
    }[],
  ) {
    const current = await this.requireEditableOrder(id);
    const nextItems = this.normalizeOrderItems(items);
    if (nextItems.length === 0) {
      throw new BadRequestException('An order needs at least one item');
    }
    const [row] = await this.db
      .update(shopOrders)
      .set({
        itemsJson: JSON.stringify(nextItems),
        amountPaise: this.orderTotal(nextItems),
        updatedAt: new Date(),
      })
      .where(eq(shopOrders.id, current.id))
      .returning();
    return { order: await this.toShopOrderDto(row!) };
  }

  async acceptShopOrder(id: string) {
    const [current] = await this.db
      .select()
      .from(shopOrders)
      .where(eq(shopOrders.id, id))
      .limit(1);
    if (!current) throw new NotFoundException('Order not found');
    if (current.status === 'accepted') return { order: await this.toShopOrderDto(current) };
    if (current.status !== 'paid') {
      throw new BadRequestException('Only a paid order can be accepted');
    }
    const order = await this.toShopOrderDto(current);
    const delivery = [order.floor, order.address, [order.city, order.pincode].filter(Boolean).join(' ')]
      .filter((part) => part.trim())
      .join(', ');
    await this.mail.sendOrderAccepted({
      to: order.email,
      customerName: order.customerName,
      items: order.items.map((item) => ({
        title: item.title,
        size: item.size,
        qty: item.qty,
        linePaise: item.stockOut ? 0 : item.unitPaise * item.qty,
        stockOut: item.stockOut,
      })),
      amountPaise: order.amountPaise,
      delivery,
    });
    const [row] = await this.db
      .update(shopOrders)
      .set({ status: 'accepted', updatedAt: new Date() })
      .where(eq(shopOrders.id, current.id))
      .returning();
    return { order: await this.toShopOrderDto(row!) };
  }

  async rejectShopOrder(id: string, reason?: string) {
    const current = await this.requireEditableOrder(id);
    const rejectReason = reason?.trim() || '';
    if (!rejectReason) throw new BadRequestException('A reason is required');
    const [row] = await this.db
      .update(shopOrders)
      .set({ status: 'rejected', rejectReason, updatedAt: new Date() })
      .where(eq(shopOrders.id, current.id))
      .returning();
    return { order: await this.toShopOrderDto(row!) };
  }

  async listShopOrders(q?: string) {
    const query = q?.trim();
    const match = query
      ? or(
          ilike(shopOrders.customerName, `%${query}%`),
          ilike(shopOrders.email, `%${query}%`),
          ilike(shopOrders.reference, `%${query}%`),
          ilike(shopOrders.address, `%${query}%`),
        )
      : undefined;
    const rows = await this.db
      .select()
      .from(shopOrders)
      .where(match)
      .orderBy(desc(shopOrders.createdAt))
      .limit(100);
    const orders = await Promise.all(rows.map((row) => this.toShopOrderDto(row)));
    return { orders };
  }

  private async requireEditableOrder(id: string) {
    const [current] = await this.db
      .select()
      .from(shopOrders)
      .where(eq(shopOrders.id, id))
      .limit(1);
    if (!current) throw new NotFoundException('Order not found');
    if (current.status !== 'pending' && current.status !== 'paid') {
      throw new BadRequestException('This order can no longer be edited');
    }
    return current;
  }

  private normalizeOrderItems(
    input: {
      slug?: string;
      title?: string;
      size?: string;
      qty?: number;
      paise?: number;
      unitPaise?: number;
      image?: string;
      stockOut?: boolean;
    }[],
  ) {
    return input.slice(0, 20).map((item) => {
      const requestedQty = Math.floor(Number(item.qty) || 0);
      const stockOut = Boolean(item.stockOut) || requestedQty < 1;
      const qty = stockOut ? 0 : Math.min(10, Math.max(1, requestedQty));
      const linePaise = Math.max(0, Math.floor(Number(item.paise) || 0));
      const unitFromLine = qty > 0 ? Math.round(linePaise / qty) : linePaise;
      const unitPaise = Math.max(
        0,
        Math.floor(Number(item.unitPaise) || unitFromLine || 0),
      );
      return {
        slug: item.slug?.trim() || '',
        title: item.title?.trim() || 'Item',
        size: item.size?.trim() || '',
        qty,
        unitPaise,
        paise: stockOut ? 0 : unitPaise * qty,
        image: item.image?.trim() || '',
        stockOut,
      };
    });
  }

  private orderTotal(items: { stockOut: boolean; unitPaise: number; qty: number }[]) {
    return items.reduce(
      (sum, item) => sum + (item.stockOut ? 0 : item.unitPaise * item.qty),
      0,
    );
  }

  private async toShopOrderDto(row: typeof shopOrders.$inferSelect) {
    let items: {
      slug: string;
      title: string;
      size: string;
      qty: number;
      unitPaise: number;
      paise: number;
      image: string;
      stockOut: boolean;
    }[] = [];
    try {
      const parsed = JSON.parse(row.itemsJson) as unknown;
      if (Array.isArray(parsed)) {
        items = this.normalizeOrderItems(
          parsed.flatMap((item) => {
            if (!item || typeof item !== 'object') return [];
            const record = item as Record<string, unknown>;
            return [
              {
                slug: typeof record.slug === 'string' ? record.slug : '',
                title: typeof record.title === 'string' ? record.title : 'Item',
                size: typeof record.size === 'string' ? record.size : '',
                qty: typeof record.qty === 'number' ? record.qty : 1,
                paise: typeof record.paise === 'number' ? record.paise : 0,
                unitPaise: typeof record.unitPaise === 'number' ? record.unitPaise : undefined,
                image: typeof record.image === 'string' ? record.image : '',
                stockOut: record.stockOut === true,
              },
            ];
          }),
        );
      }
    } catch {
      items = [];
    }
    const missing = [...new Set(items.filter((item) => !item.image && item.slug).map((item) => item.slug))];
    if (missing.length > 0) {
      const products = await this.db
        .select({ slug: storeProducts.slug, imageUrl: storeProducts.imageUrl })
        .from(storeProducts)
        .where(inArray(storeProducts.slug, missing));
      const images = new Map(products.map((product) => [product.slug, product.imageUrl || '']));
      items = items.map((item) =>
        item.image ? item : { ...item, image: images.get(item.slug) || '' },
      );
    }
    return {
      id: row.id,
      reference: row.reference,
      pineOrderId: row.pineOrderId,
      status: row.status,
      customerName: row.customerName,
      email: row.email,
      mobile: row.mobile,
      floor: row.floor,
      address: row.address,
      city: row.city,
      pincode: row.pincode,
      rejectReason: row.rejectReason,
      items,
      amountPaise: items.length > 0 ? this.orderTotal(items) : row.amountPaise,
      createdAt: row.createdAt.toISOString(),
    };
  }

  async removePromo(id: string) {
    const [row] = await this.db
      .delete(shopPromos)
      .where(eq(shopPromos.id, id))
      .returning({ id: shopPromos.id });
    if (!row) throw new NotFoundException('Promo not found');
    return { ok: true as const };
  }

  async remove(id: string) {
    const [row] = await this.db
      .delete(storeProducts)
      .where(eq(storeProducts.id, id))
      .returning({ id: storeProducts.id });
    if (!row) throw new NotFoundException('Product not found');
    return { ok: true as const };
  }

  private async ensureSeeded() {
    if (this.seeding) return this.seeding;
    this.seeding = (async () => {
      const [catCount] = await this.db.select({ n: count() }).from(storeCategories);
      if ((catCount?.n ?? 0) === 0) {
        for (const item of CATEGORY_SEED) {
          await this.db.insert(storeCategories).values({
            slug: item.slug,
            label: item.label,
            sortOrder: item.sortOrder,
            active: true,
          });
        }
      }

      const [kindCount] = await this.db.select({ n: count() }).from(storeKinds);
      if ((kindCount?.n ?? 0) === 0) {
        for (const item of KIND_SEED) {
          await this.db.insert(storeKinds).values({
            slug: item.slug,
            label: item.label,
            sortOrder: item.sortOrder,
            active: true,
          });
        }
      }

      const [prodCount] = await this.db.select({ n: count() }).from(storeProducts);
      if ((prodCount?.n ?? 0) === 0) {
        for (const item of STORE_SEED_PRODUCTS) {
          await this.db.insert(storeProducts).values({
            slug: item.slug,
            title: item.title,
            subtitle: item.subtitle,
            description: item.description ?? null,
            category: item.category,
            kind: item.kind,
            priceLabel: item.priceLabel,
            pricePaise: item.pricePaise ?? null,
            coinPrice: item.coinPrice ?? null,
            imageUrl: item.imageUrl ?? null,
            sizes: item.sizes?.length ? JSON.stringify(item.sizes) : null,
            planId: item.planId ?? null,
            active: true,
            sortOrder: item.sortOrder,
          });
        }
      }

      await this.db
        .update(storeCategories)
        .set({ label: 'E-Books', updatedAt: new Date() })
        .where(eq(storeCategories.slug, 'ebooks'));

      const retired = await this.db
        .select({ id: storeProducts.id })
        .from(storeProducts)
        .where(inArray(storeProducts.category, [...RETIRED_CATEGORIES]));
      if (retired.length > 0) {
        const ids = retired.map((row) => row.id);
        await this.db
          .delete(coinRedemptions)
          .where(inArray(coinRedemptions.productId, ids));
        await this.db.delete(storeProducts).where(inArray(storeProducts.id, ids));
      }
      await this.db
        .delete(storeCategories)
        .where(inArray(storeCategories.slug, [...RETIRED_CATEGORIES]));

      const [promoCount] = await this.db.select({ n: count() }).from(shopPromos);
      if ((promoCount?.n ?? 0) === 0) {
        for (const item of PROMO_SEED) {
          await this.db.insert(shopPromos).values({
            placement: item.placement,
            imageUrl: item.imageUrl,
            alt: item.alt,
            label: item.label,
            category: item.category,
            active: true,
            sortOrder: item.sortOrder,
          });
        }
      }
    })().finally(() => {
      this.seeding = null;
    });
    return this.seeding;
  }

  private async requireCategorySlug(slug: string) {
    const [row] = await this.db
      .select()
      .from(storeCategories)
      .where(eq(storeCategories.slug, slug))
      .limit(1);
    if (!row) throw new BadRequestException(`Unknown category “${slug}”`);
    return row;
  }

  private async requireKindSlug(slug: string) {
    const [row] = await this.db
      .select()
      .from(storeKinds)
      .where(eq(storeKinds.slug, slug))
      .limit(1);
    if (!row) throw new BadRequestException(`Unknown kind “${slug}”`);
    return row;
  }

  private async toProductRow(
    input: StoreProductInput,
    creating: boolean,
    current?: typeof storeProducts.$inferSelect,
  ) {
    const title = (input.title ?? current?.title ?? '').trim();
    if (!title) throw new BadRequestException('Title is required');

    const slug = this.slugify(
      (input.slug ?? current?.slug ?? title).trim() || title,
    );
    if (!slug) throw new BadRequestException('Slug is required');

    const category = (input.category ?? current?.category ?? 'plans')
      .trim()
      .toLowerCase();
    await this.requireCategorySlug(category);

    const kind = (input.kind ?? current?.kind ?? (category === 'plans' ? 'plan' : 'merch'))
      .trim()
      .toLowerCase();
    await this.requireKindSlug(kind);

    const priceLabel = (input.priceLabel ?? current?.priceLabel ?? '').trim();
    if (!priceLabel) throw new BadRequestException('priceLabel is required');

    const sizes = this.normalizeSizes(
      input.sizes !== undefined ? input.sizes : current?.sizes,
    );

    let planId =
      input.planId !== undefined
        ? input.planId?.trim() || null
        : current?.planId ?? null;
    if (kind === 'plan' && !planId) {
      throw new BadRequestException('planId is required for plan products');
    }
    if (kind !== 'plan') planId = null;

    const sortOrder =
      input.sortOrder !== undefined
        ? Number(input.sortOrder)
        : (current?.sortOrder ?? 0);

    return {
      slug,
      title,
      subtitle: (input.subtitle ?? current?.subtitle ?? '').trim(),
      description:
        input.description !== undefined
          ? input.description?.trim() || null
          : current?.description ?? null,
      category,
      kind,
      priceLabel,
      pricePaise:
        input.pricePaise !== undefined
          ? input.pricePaise
          : (current?.pricePaise ?? null),
      coinPrice:
        input.coinPrice !== undefined
          ? input.coinPrice
          : ((current as { coinPrice?: number | null } | undefined)?.coinPrice ??
            null),
      imageUrl:
        input.imageUrl !== undefined
          ? input.imageUrl?.trim() || null
          : current?.imageUrl ?? null,
      sizes: sizes.length ? JSON.stringify(sizes) : null,
      planId,
      active:
        input.active !== undefined
          ? Boolean(input.active)
          : (current?.active ?? true),
      comingSoon:
        input.comingSoon !== undefined
          ? Boolean(input.comingSoon)
          : (current?.comingSoon ?? false),
      sortOrder: Number.isFinite(sortOrder) ? sortOrder : 0,
    };
  }

  private toTaxonomyRow(
    input: StoreTaxonomyInput,
    creating: boolean,
    current?: { slug: string; label: string; sortOrder: number; active: boolean },
  ) {
    const label = (input.label ?? current?.label ?? '').trim();
    if (!label) throw new BadRequestException('Label is required');
    const slug =
      this.slugify((input.slug ?? current?.slug ?? label).trim() || label) ||
      `tab-${Date.now().toString(36)}`;
    const sortOrder =
      input.sortOrder !== undefined
        ? Number(input.sortOrder)
        : (current?.sortOrder ?? (creating ? 100 : 0));
    return {
      slug,
      label,
      sortOrder: Number.isFinite(sortOrder) ? sortOrder : 0,
      active:
        input.active !== undefined
          ? Boolean(input.active)
          : (current?.active ?? true),
    };
  }

  private normalizeSizes(raw: string[] | string | null | undefined): string[] {
    if (raw == null) return [];
    if (Array.isArray(raw)) {
      return raw.map((s) => String(s).trim()).filter(Boolean);
    }
    const text = String(raw).trim();
    if (!text) return [];
    try {
      const parsed = JSON.parse(text);
      if (Array.isArray(parsed)) {
        return parsed.map((s) => String(s).trim()).filter(Boolean);
      }
    } catch {
      /* comma-separated */
    }
    return text
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
  }

  private slugify(value: string) {
    return value
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 80);
  }

  private toTaxonomyDto(row: {
    id: string;
    slug: string;
    label: string;
    sortOrder: number;
    active: boolean;
    comingSoon?: boolean;
    createdAt: Date;
    updatedAt: Date;
  }): StoreTaxonomyDto {
    return {
      id: row.id,
      slug: row.slug,
      label: row.label,
      sortOrder: row.sortOrder,
      active: row.active,
      comingSoon: Boolean(row.comingSoon),
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
    };
  }

  private parsePlacement(value: string | undefined, required: boolean) {
    const placement = (value ?? '').trim();
    if (!placement) {
      if (required) throw new BadRequestException('Placement is required');
      return null;
    }
    if (placement !== 'banner' && placement !== 'card') {
      throw new BadRequestException('Placement must be banner or card');
    }
    return placement;
  }

  private async toPromoRow(
    input: ShopPromoInput,
    creating: boolean,
    current?: typeof shopPromos.$inferSelect,
  ) {
    const placement = this.parsePlacement(
      input.placement ?? current?.placement,
      true,
    )!;
    const imageUrl = (input.imageUrl ?? current?.imageUrl ?? '').trim();
    if (!imageUrl) throw new BadRequestException('Image is required');
    const alt = (input.alt ?? current?.alt ?? '').trim();
    if (!alt) throw new BadRequestException('Alt text is required');
    const label = (input.label ?? current?.label ?? '').trim();
    const category = (input.category ?? current?.category ?? '').trim();
    if (category) await this.requireCategorySlug(category);
    const sortOrder =
      input.sortOrder != null && Number.isFinite(input.sortOrder)
        ? Math.trunc(input.sortOrder)
        : (current?.sortOrder ?? 0);
    const active = input.active ?? current?.active ?? true;
    if (!creating && !current) throw new NotFoundException('Promo not found');
    return { placement, imageUrl, alt, label, category, sortOrder, active };
  }

  private toPromoDto(row: typeof shopPromos.$inferSelect): ShopPromoDto {
    return {
      id: row.id,
      placement: row.placement === 'card' ? 'card' : 'banner',
      imageUrl: row.imageUrl,
      alt: row.alt,
      label: row.label,
      category: row.category,
      active: row.active,
      sortOrder: row.sortOrder,
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
    };
  }

  private toShopProduct(row: typeof storeProducts.$inferSelect) {
    return {
      slug: row.slug,
      title: row.title,
      subtitle: row.subtitle ?? '',
      description: row.description ?? '',
      category: row.category,
      priceLabel: row.priceLabel,
      pricePaise: row.pricePaise,
      image: row.imageUrl,
      sizes: this.normalizeSizes(row.sizes),
      comingSoon: row.comingSoon,
    };
  }

  private toProductDto(row: typeof storeProducts.$inferSelect): StoreProductDto {
    return {
      id: row.id,
      slug: row.slug,
      title: row.title,
      subtitle: row.subtitle ?? '',
      description: row.description,
      category: row.category,
      kind: row.kind,
      priceLabel: row.priceLabel,
      pricePaise: row.pricePaise,
      coinPrice: row.coinPrice ?? null,
      imageUrl: row.imageUrl,
      sizes: this.normalizeSizes(row.sizes),
      planId: row.planId,
      active: row.active,
      comingSoon: row.comingSoon,
      sortOrder: row.sortOrder,
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
    };
  }

  async redeemWithCoins(
    userId: string,
    input: { productId?: string; size?: string },
  ) {
    const productId = input.productId?.trim();
    if (!productId) throw new BadRequestException('productId is required');

    const [product] = await this.db
      .select()
      .from(storeProducts)
      .where(eq(storeProducts.id, productId))
      .limit(1);
    if (!product || !product.active) {
      throw new NotFoundException('Product not found');
    }
    const coinPrice = product.coinPrice;
    if (coinPrice == null || coinPrice <= 0) {
      throw new BadRequestException('Product is not redeemable with coins');
    }

    const sizes = this.normalizeSizes(product.sizes);
    const size = input.size?.trim() || null;
    if (sizes.length && (!size || !sizes.includes(size))) {
      throw new BadRequestException(`Choose a size: ${sizes.join(', ')}`);
    }

    const [redemption] = await this.db
      .insert(coinRedemptions)
      .values({
        userId,
        productId: product.id,
        coinsSpent: coinPrice,
        size,
        status: 'pending',
      })
      .returning();

    try {
      const rewards = await this.wallet.debitCoins({
        userId,
        amount: coinPrice,
        reason: 'store_redeem',
        refType: 'redemption',
        refId: redemption!.id,
      });
      return {
        redemption: {
          id: redemption!.id,
          productId: product.id,
          productTitle: product.title,
          coinsSpent: coinPrice,
          size,
          status: redemption!.status,
          createdAt: redemption!.createdAt.toISOString(),
        },
        rewards,
      };
    } catch (err) {
      await this.db
        .delete(coinRedemptions)
        .where(eq(coinRedemptions.id, redemption!.id));
      throw err;
    }
  }

  async listRedemptions(opts?: { status?: string; limit?: number }) {
    const limit = Math.min(200, Math.max(1, opts?.limit ?? 50));
    const rows = opts?.status
      ? await this.db
          .select({
            redemption: coinRedemptions,
            productTitle: storeProducts.title,
            productSlug: storeProducts.slug,
          })
          .from(coinRedemptions)
          .innerJoin(
            storeProducts,
            eq(coinRedemptions.productId, storeProducts.id),
          )
          .where(eq(coinRedemptions.status, opts.status))
          .orderBy(desc(coinRedemptions.createdAt))
          .limit(limit)
      : await this.db
          .select({
            redemption: coinRedemptions,
            productTitle: storeProducts.title,
            productSlug: storeProducts.slug,
          })
          .from(coinRedemptions)
          .innerJoin(
            storeProducts,
            eq(coinRedemptions.productId, storeProducts.id),
          )
          .orderBy(desc(coinRedemptions.createdAt))
          .limit(limit);

    return {
      redemptions: rows.map((r) => ({
        id: r.redemption.id,
        userId: r.redemption.userId,
        productId: r.redemption.productId,
        productTitle: r.productTitle,
        productSlug: r.productSlug,
        coinsSpent: r.redemption.coinsSpent,
        size: r.redemption.size,
        status: r.redemption.status,
        notes: r.redemption.notes,
        createdAt: r.redemption.createdAt.toISOString(),
        updatedAt: r.redemption.updatedAt.toISOString(),
      })),
    };
  }

  async updateRedemptionStatus(
    id: string,
    input: { status?: string; notes?: string | null },
  ) {
    const status = input.status?.trim();
    if (!status || !['pending', 'fulfilled', 'cancelled'].includes(status)) {
      throw new BadRequestException('status must be pending|fulfilled|cancelled');
    }
    const [current] = await this.db
      .select()
      .from(coinRedemptions)
      .where(eq(coinRedemptions.id, id))
      .limit(1);
    if (!current) throw new NotFoundException('Redemption not found');

    if (status === 'cancelled' && current.status === 'pending') {
      await this.wallet.creditCoins({
        userId: current.userId,
        amount: current.coinsSpent,
        reason: 'redeem_refund',
        refType: 'redemption',
        refId: current.id,
      });
    }

    const [updated] = await this.db
      .update(coinRedemptions)
      .set({
        status,
        notes:
          input.notes !== undefined
            ? input.notes?.trim() || null
            : current.notes,
        updatedAt: new Date(),
      })
      .where(eq(coinRedemptions.id, id))
      .returning();

    return {
      redemption: {
        id: updated!.id,
        userId: updated!.userId,
        productId: updated!.productId,
        coinsSpent: updated!.coinsSpent,
        size: updated!.size,
        status: updated!.status,
        notes: updated!.notes,
        createdAt: updated!.createdAt.toISOString(),
        updatedAt: updated!.updatedAt.toISOString(),
      },
    };
  }
}
