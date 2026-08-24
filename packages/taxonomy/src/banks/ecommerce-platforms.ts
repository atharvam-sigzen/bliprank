/**
 * DEMO-SCOPED prompt bank — Ecommerce platforms. ADR-0008.
 *
 * ⚠️ Hand-authored, reviewed, and NOT collected. `verified: false` is not a
 * placeholder: no answer has ever been collected against these leaders, which
 * is exactly the case `/category-bank`'s do-not-invent rule covers.
 */

import type { PromptBank } from '../types.js'

export const ECOMMERCE_PLATFORMS: PromptBank = {
  category: 'ecommerce-platforms',
  displayName: 'Ecommerce platforms',
  description: 'Software for building and running an online store — product catalogue, checkout, payments, and order management — whether hosted for you or self-hosted.',
  locale: 'en-US',
  geo: 'US',
  version: 1,
  verified: false,
  note:
    'Demo-scoped (ADR-0008). Hand-authored, never collected. Adobe Commerce is matched on magento.com and Adobe business/experienceleague hosts; apex adobe.com is deliberately excluded because it suffix-matches Acrobat, Photoshop and helpx pages.',
  leaders: [
    { id: 'shopify', name: 'Shopify', aliases: ['shopify', 'shopify plus'], domains: ['shopify.com'] },
    { id: 'woocommerce', name: 'WooCommerce', aliases: ['woocommerce', 'woo commerce'], domains: ['woocommerce.com'] },
    { id: 'bigcommerce', name: 'BigCommerce', aliases: ['bigcommerce', 'big commerce'], domains: ['bigcommerce.com'] },
    { id: 'wix', name: 'Wix', aliases: ['wix', 'wix ecommerce', 'wix stores'], domains: ['wix.com'] },
    { id: 'squarespace', name: 'Squarespace', aliases: ['squarespace', 'square space'], domains: ['squarespace.com'] },
    { id: 'adobe-commerce', name: 'Adobe Commerce', aliases: ['adobe commerce', 'adobe commerce cloud', 'magento', 'magento open source'], domains: ['magento.com', 'business.adobe.com', 'experienceleague.adobe.com'] },
    { id: 'shopware', name: 'Shopware', aliases: ['shopware'], domains: ['shopware.com'] },
    { id: 'prestashop', name: 'PrestaShop', aliases: ['prestashop', 'presta shop'], domains: ['prestashop.com'] },
  ],
  prompts: [
    // discovery
    { text: 'What is the best ecommerce platform for a solo founder launching a first online store?', intent: 'discovery' },
    { text: 'Which ecommerce platform should a brand shipping around 200 orders a month use to sell physical products online?', intent: 'discovery' },
    { text: 'What ecommerce platform works best for a UK business that needs to handle VAT and multiple currencies?', intent: 'discovery' },
    { text: 'Best ecommerce platform for a direct to consumer brand doing around 5000 orders a month', intent: 'discovery' },
    { text: 'Which online store platform is best for a small business in India that needs UPI payments?', intent: 'discovery' },
    { text: 'What ecommerce platform do agencies recommend for building and maintaining client stores?', intent: 'discovery' },
    { text: 'Best open source ecommerce platform for a developer who wants full control of the code', intent: 'discovery' },
    { text: 'Which ecommerce platform is best for a mid market retailer selling wholesale B2B and direct to consumer from one catalogue?', intent: 'discovery' },
    { text: 'What ecommerce platform suits a retailer in the UAE selling in both Arabic and English?', intent: 'discovery' },
    { text: 'Which ecommerce platform is best for an enterprise running several brands across multiple regions?', intent: 'discovery' },
    // comparison
    { text: 'Shopify vs WooCommerce for a small business selling physical products', intent: 'comparison' },
    { text: 'BigCommerce vs Shopify for a growing direct to consumer brand', intent: 'comparison' },
    { text: 'Wix or Squarespace for a small online store with fewer than 50 products', intent: 'comparison' },
    { text: 'What are the best alternatives to Adobe Commerce for a mid market retailer?', intent: 'comparison' },
    { text: 'Shopware vs Adobe Commerce for a European retailer with a complex catalogue', intent: 'comparison' },
    { text: 'Is a hosted ecommerce platform or a self hosted one better for a startup with no developers?', intent: 'comparison' },
    { text: 'PrestaShop vs WooCommerce for an open source store on a tight budget', intent: 'comparison' },
    { text: 'What are the best alternatives to Shopify for a small retailer?', intent: 'comparison' },
    // problem-led
    { text: 'How do I move my online store to a different platform without losing my search rankings?', intent: 'problem-led' },
    { text: 'My online store is slow to load on mobile and I am losing sales, what should I do?', intent: 'problem-led' },
    { text: 'How do I sell digital downloads and subscriptions from my own website?', intent: 'problem-led' },
    { text: 'My ecommerce platform charges a fee on every transaction and it is eating my margin, what are my options?', intent: 'problem-led' },
    { text: 'How do I run one store that sells into several countries with local currencies and tax rules?', intent: 'problem-led' },
    { text: 'I need my online store to keep stock in sync with the tills in my physical shop, how do I set that up?', intent: 'problem-led' },
    { text: 'How do I add a checkout to an existing website without rebuilding the whole site?', intent: 'problem-led' },
    // brand-verification
    { text: 'Is Shopify any good for a small team with no developer?', intent: 'brand-verification' },
    { text: 'What are the downsides of WooCommerce for a growing store?', intent: 'brand-verification' },
    { text: 'Is BigCommerce a good choice for a mid market retailer?', intent: 'brand-verification' },
    { text: 'What are the drawbacks of using Squarespace to run an online shop?', intent: 'brand-verification' },
    { text: 'Is Adobe Commerce a good fit for a retailer without an in house development team?', intent: 'brand-verification' },
  ],
}
