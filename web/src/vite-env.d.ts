/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** Override the local live REST API URL or configure a production build. */
  readonly VITE_API_BASE_URL?: string;
  readonly VITE_AGENT_API_BASE_URL?: string;
  readonly VITE_API_TOKEN?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
