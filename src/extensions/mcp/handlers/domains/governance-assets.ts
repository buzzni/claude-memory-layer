import { createMcpHandlerDomain } from '../domain-handler.js';

export const governanceAssetsDomain = createMcpHandlerDomain('governance-assets', [
  'mem-asset-create',
  'mem-asset-get',
  'mem-asset-list',
  'mem-asset-catalog-sync',
  'mem-asset-update',
  'mem-asset-bind',
  'mem-asset-grant-set',
  'mem-asset-check',
  'mem-actor-list',
  'mem-actor-card-get',
  'mem-actor-card-upsert',
  'mem-core-block-get',
  'mem-core-block-update'
]);
