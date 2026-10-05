import { Controller, Get, NotFoundException, Param } from '@nestjs/common';
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

  @Get('products/:slug')
  async product(@Param('slug') slug: string) {
    const product = await this.store.getShopProduct(slug);
    if (!product) throw new NotFoundException('Product not found');
    return { product };
  }
}
