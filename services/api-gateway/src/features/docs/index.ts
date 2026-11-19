// Public API of the docs feature (the single, merged Swagger UI).
export { createDocsModule, createDocsSources } from './docs.module.js';
export { type DocsSource, type FetchedSpec, type OpenApiDoc, mergeSpecs } from './docs.merge.js';
export { DocsAggregator } from './docs.service.js';
