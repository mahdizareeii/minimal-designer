export const DOCUMENT_SCHEMA_VERSION_V1 = 1 as const;
export const DOCUMENT_SCHEMA_VERSION_V2 = 2 as const;

// These versions are intentionally independent. A renderer or command-engine
// upgrade must not silently change the meaning of a stored document schema.
export const DATABASE_SCHEMA_VERSION = 16 as const;
export const COMMAND_ENGINE_VERSION = "2" as const;
export const RENDERER_VERSION = "3" as const;
export const RASTER_NORMALIZER_VERSION = "1" as const;
export const RENDERER_IPC_PROTOCOL_VERSION = 2 as const;
export const FONT_BUNDLE_VERSION = "1" as const;
export const EXPORT_FORMAT_VERSION = 1 as const;
export const APPLICATION_BUILD_VERSION = "0.2.0" as const;

export const ENGINE_VERSIONS = Object.freeze({
  documentSchema: DOCUMENT_SCHEMA_VERSION_V2,
  databaseSchema: DATABASE_SCHEMA_VERSION,
  commandEngine: COMMAND_ENGINE_VERSION,
  renderer: RENDERER_VERSION,
  rasterNormalizer: RASTER_NORMALIZER_VERSION,
  rendererIpcProtocol: RENDERER_IPC_PROTOCOL_VERSION,
  fontBundle: FONT_BUNDLE_VERSION,
  exportFormat: EXPORT_FORMAT_VERSION,
  applicationBuild: APPLICATION_BUILD_VERSION,
});
