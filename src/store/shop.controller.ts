import { Body, Controller, Get, NotFoundException, Param, Post, UseGuards } from '@nestjs/common';
import { InternalGuard } from '../auth/internal.guard.js';
import { StoreService } from './store.service.js';

@Controller('shop')
export class ShopController {
  constructor(private readonly store: StoreService) {}

  @Get()
  catalog() {
    return this.store.listShop();
  }

  @Get('maps-key')
  mapsKey() {
    const apiKey = process.env.GOOGLE_MAPS_API_KEY?.trim() || '';
    return { apiKey };
  }

  @Post('orders')
  @UseGuards(InternalGuard)
  createOrder(
    @Body()
    body: {
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
      }[];
      amountPaise?: number;
    },
  ) {
    return this.store.createShopOrder(body);
  }

  @Post('orders/:reference/paid')
  @UseGuards(InternalGuard)
  markOrderPaid(
    @Param('reference') reference: string,
    @Body() body: { pineOrderId?: string },
  ) {
    return this.store.markShopOrderPaid(reference, body?.pineOrderId);
  }

  @Get('products/:slug')
  async product(@Param('slug') slug: string) {
    const product = await this.store.getShopProduct(slug);
    if (!product) throw new NotFoundException('Product not found');
    return { product };
  }
}
