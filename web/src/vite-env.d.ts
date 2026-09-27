/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** Set to point the app at a live REST API instead of the static fixtures. */
  readonly VITE_API_BASE_URL?: string;
  readonly VITE_AGENT_API_BASE_URL?: string;
  readonly VITE_API_TOKEN?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
