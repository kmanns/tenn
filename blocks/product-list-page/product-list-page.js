// Product Discovery Dropins
import SearchResults from '@dropins/storefront-product-discovery/containers/SearchResults.js';
import Facets from '@dropins/storefront-product-discovery/containers/Facets.js';
import SortBy from '@dropins/storefront-product-discovery/containers/SortBy.js';
import Pagination from '@dropins/storefront-product-discovery/containers/Pagination.js';
import { render as provider } from '@dropins/storefront-product-discovery/render.js';
import { Button, Icon, provider as UI } from '@dropins/tools/components.js';
import { search } from '@dropins/storefront-product-discovery/api.js';
// Wishlist Dropin
import { WishlistToggle } from '@dropins/storefront-wishlist/containers/WishlistToggle.js';
import { render as wishlistRender } from '@dropins/storefront-wishlist/render.js';
// Cart Dropin
import * as cartApi from '@dropins/storefront-cart/api.js';
import { tryRenderAemAssetsImage } from '@dropins/tools/lib/aem/assets.js';
// Event Bus
import { events } from '@dropins/tools/event-bus.js';
// AEM
import { readBlockConfig } from '../../scripts/aem.js';
import { fetchPlaceholders, getProductLink } from '../../scripts/commerce.js';
import { getSearchStateFromUrl, applySearchStateToUrl } from './search-url.js';
// Config
import { getConfigValue } from '@dropins/tools/lib/aem/configs.js';

// Fallback SKUs — queried directly from Catalog Service when Live Search returns 0
const FALLBACK_SKUS = [
  'TNSP-1001', 'TNSP-1002', 'TNSP-1003', 'TNSP-1004',
  'TNSP-1005', 'TNSP-1006', 'TNSP-1007', 'TNSP-1008', 'TNSP-1009',
];

async function fetchProductsBySku(skus) {
  const endpoint = getConfigValue('commerce-core-endpoint') || getConfigValue('commerce-endpoint');
  if (!endpoint) return [];
  const headers = {
    'Content-Type': 'application/json',
    Store: getConfigValue('headers.all.Store') || 'tenneng',
    'Magento-Store-View-Code': getConfigValue('headers.cs.Magento-Store-View-Code') || 'tenneng',
    'Magento-Store-Code': getConfigValue('headers.cs.Magento-Store-Code') || 'tsp',
    'Magento-Website-Code': getConfigValue('headers.cs.Magento-Website-Code') || 'tenn',
  };
  const query = `{ products(skus: ${JSON.stringify(skus)}) {
    sku name urlKey
    images { url roles }
    ... on SimpleProductView { price { final { amount { value currency } } } }
    ... on ComplexProductView { priceRange { minimum { final { amount { value currency } } } } }
  } }`;
  try {
    const r = await fetch(endpoint, { method: 'POST', headers, body: JSON.stringify({ query }) });
    const d = await r.json();
    return d?.data?.products || [];
  } catch { return []; }
}

function renderFallbackGrid(container, products, getLink) {
  const outer = document.createElement('div');
  outer.className = 'product-discovery-product-list';
  const inner = document.createElement('div');
  inner.className = 'product-discovery-product-list__container';
  const grid = document.createElement('div');
  grid.className = 'product-discovery-product-list__grid';

  for (const product of products) {
    const img = (product.images || []).find((i) => (i.roles || []).includes('image')) || product.images?.[0];
    const priceVal = product.price?.final?.amount?.value
      ?? product.priceRange?.minimum?.final?.amount?.value ?? 0;
    const currency = product.price?.final?.amount?.currency
      ?? product.priceRange?.minimum?.final?.amount?.currency ?? 'USD';
    const priceStr = new Intl.NumberFormat('en-US', { style: 'currency', currency }).format(priceVal);
    const href = getLink(product.urlKey, product.sku);

    const card = document.createElement('div');
    card.className = 'dropin-product-item-card';
    card.style.cssText = '--imageWidth:1;--imageHeight:1;';

    const anchor = document.createElement('a');
    anchor.href = href;

    if (img?.url) {
      const imgEl = document.createElement('img');
      imgEl.src = `${img.url}?width=300&format=webply&quality=85`;
      imgEl.alt = product.name;
      imgEl.loading = 'lazy';
      imgEl.style.cssText = 'width:100%;aspect-ratio:1/1;object-fit:cover;display:block;';
      anchor.appendChild(imgEl);
    }

    const info = document.createElement('div');
    info.style.cssText = 'padding:var(--spacing-small,12px);';

    const nameEl = document.createElement('p');
    nameEl.style.cssText = 'margin:0 0 var(--spacing-xsmall,8px);font:var(--type-body-1-default-font,1rem/1.4 sans-serif);';
    nameEl.textContent = product.name;

    const priceEl = document.createElement('p');
    priceEl.className = 'product-price';
    priceEl.style.cssText = 'margin:0;font-weight:600;';
    priceEl.textContent = priceStr;

    info.appendChild(nameEl);
    info.appendChild(priceEl);
    anchor.appendChild(info);
    card.appendChild(anchor);
    grid.appendChild(card);
  }

  inner.appendChild(grid);
  outer.appendChild(inner);
  container.innerHTML = '';
  container.appendChild(outer);
}

// Initializers
import '../../scripts/initializers/search.js';
import '../../scripts/initializers/wishlist.js';

export default async function decorate(block) {
  const labels = await fetchPlaceholders();

  const config = readBlockConfig(block);
  const pageSize = parseInt(config.pagesize, 10) || 9;

  const fragment = document.createRange()
    .createContextualFragment(`
    <div class="search__wrapper">
      <div class="search__result-info"></div>
      <div class="search__view-facets"></div>
      <div class="search__facets"></div>
      <div class="search__product-sort"></div>
      <div class="search__product-list"></div>
      <div class="search__pagination"></div>
    </div>
  `);

  const $resultInfo = fragment.querySelector('.search__result-info');
  const $viewFacets = fragment.querySelector('.search__view-facets');
  const $facets = fragment.querySelector('.search__facets');
  const $productSort = fragment.querySelector('.search__product-sort');
  const $productList = fragment.querySelector('.search__product-list');
  const $pagination = fragment.querySelector('.search__pagination');

  block.innerHTML = '';
  block.appendChild(fragment);

  // Add url path back to the block for enrichment, incase enrichment block is
  // executed after the plp block and block config is not available
  if (config.urlpath) {
    block.dataset.urlpath = config.urlpath;
  }

  const searchState = getSearchStateFromUrl(new URL(window.location.href));

  // Default visibility filter for all of our requests
  const visibilityFilter = { attribute: 'visibility', in: ['Search', 'Catalog, Search'] };
  const userFilters = searchState.filter.filter((f) => f.attribute !== 'visibility');

  // Normalize URL (e.g. pipe-separated filter values)
  const normalizedUrl = new URL(window.location.href);
  applySearchStateToUrl(normalizedUrl, searchState);
  window.history.replaceState({}, '', normalizedUrl.toString());

  // Request search based on the page type on block load
  if (config.urlpath) {
    // If it's a category page...
    await search({
      phrase: '', // search all products in the category
      currentPage: searchState.currentPage,
      pageSize,
      sort: searchState?.sort?.length ? searchState.sort : [{ attribute: 'position', direction: 'DESC' }],
      filter: [
        { attribute: 'categoryPath', eq: config.urlpath }, // Add category filter
        // Always add visibility filter to the request
        visibilityFilter,
        ...userFilters,
      ],
    }).catch(() => {
      console.error('Error searching for products');
    });
  } else {
    // Search page: dropin uses only the request (no URL parsing).
    await search({
      phrase: searchState.phrase,
      currentPage: searchState.currentPage,
      pageSize,
      sort: searchState.sort,
      // Always add visibility filter to the request
      filter: [visibilityFilter, ...userFilters],
    }).catch((e) => {
      console.error('Error searching for products', e);
    });
  }

  const getAddToCartButton = (product) => {
    if (product.typename === 'ComplexProductView') {
      const button = document.createElement('div');
      UI.render(Button, {
        children: labels.Global?.AddProductToCart,
        icon: Icon({ source: 'Cart' }),
        href: getProductLink(product.urlKey, product.sku),
        variant: 'primary',
      })(button);
      return button;
    }
    const button = document.createElement('div');
    UI.render(Button, {
      children: labels.Global?.AddProductToCart,
      icon: Icon({ source: 'Cart' }),
      onClick: () => cartApi.addProductsToCart([{
        sku: product.sku,
        quantity: 1,
      }]),
      variant: 'primary',
      disabled: !product.inStock,
    })(button);
    return button;
  };

  await Promise.all([
    // Sort By
    provider.render(SortBy, {})($productSort),

    // Pagination
    provider.render(Pagination, {
      onPageChange: () => {
        // scroll to the top of the page
        window.scrollTo({
          top: 0,
          behavior: 'smooth',
        });
      },
    })($pagination),

    // View Facets Button
    UI.render(Button, {
      children: labels.Global?.Filters,
      icon: Icon({ source: 'Burger' }),
      variant: 'secondary',
      onClick: () => {
        $facets.classList.toggle('search__facets--visible');
      },
    })($viewFacets),

    // Facets
    provider.render(Facets, {})($facets),
    // Product List
    provider.render(SearchResults, {
      routeProduct: (product) => getProductLink(product.urlKey, product.sku),
      slots: {
        ProductImage: (ctx) => {
          const {
            product,
            defaultImageProps,
          } = ctx;
          const anchorWrapper = document.createElement('a');
          anchorWrapper.href = getProductLink(product.urlKey, product.sku);

          tryRenderAemAssetsImage(ctx, {
            alias: product.sku,
            imageProps: defaultImageProps,
            wrapper: anchorWrapper,
            params: {
              width: defaultImageProps.width,
              height: defaultImageProps.height,
            },
          });
        },
        ProductActions: async (ctx) => {
          const actionsWrapper = document.createElement('div');
          actionsWrapper.className = 'product-discovery-product-actions';
          // Add to Cart Button
          const addToCartBtn = getAddToCartButton(ctx.product);
          addToCartBtn.className = 'product-discovery-product-actions__add-to-cart';
          // Wishlist Button
          const $wishlistToggle = document.createElement('div');
          $wishlistToggle.classList.add('product-discovery-product-actions__wishlist-toggle');
          wishlistRender.render(WishlistToggle, {
            product: ctx.product,
            variant: 'tertiary',
          })($wishlistToggle);
          actionsWrapper.appendChild(addToCartBtn);
          actionsWrapper.appendChild($wishlistToggle);

          // Conditionally load and render Requisition List Button
          try {
            const { initializeRequisitionList } = await import('./requisition-list.js');

            const $reqListContainer = await initializeRequisitionList({
              product: ctx.product,
              labels,
            });

            actionsWrapper.appendChild($reqListContainer);
          } catch (error) {
            console.warn('Requisition list module not available:', error);
          }

          ctx.replaceWith(actionsWrapper);
        },
      },
    })($productList),
  ]);

  // Listen for search results (event is fired before the block is rendered; eager: true)
  events.on('search/result', (payload) => {
    const totalCount = payload.result?.totalCount || 0;

    block.classList.toggle('product-list-page--empty', totalCount === 0);

    // Results Info
    $resultInfo.innerHTML = payload.request?.phrase
      ? `${totalCount} results found for <strong>"${payload.request.phrase}"</strong>.`
      : `${totalCount} results found.`;

    // Update the view facets button with the number of filters
    if (payload.request.filter.length > 0) {
      $viewFacets.querySelector('button')
        .setAttribute('data-count', payload.request.filter.length);
    } else {
      $viewFacets.querySelector('button')
        .removeAttribute('data-count');
    }
  }, { eager: true });

  // Listen for search results (event is fired after the block is rendered; eager: false)
  // URL is owned by this project; update it when search state changes.
  events.on('search/result', async (payload) => {
    const url = new URL(window.location.href);
    applySearchStateToUrl(url, payload.request);
    window.history.pushState({}, '', url.toString());

    // Fallback: if Live Search returns 0 products, load directly from Catalog Service
    if ((payload.result?.totalCount || 0) === 0) {
      const fallback = await fetchProductsBySku(FALLBACK_SKUS);
      if (fallback.length > 0) {
        renderFallbackGrid($productList, fallback, getProductLink);
        block.classList.remove('product-list-page--empty');
        $resultInfo.innerHTML = `${fallback.length} results found.`;
      }
    }
  }, { eager: false });
}
