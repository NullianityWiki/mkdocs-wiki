// environment.d.ts
declare global {
  namespace NodeJS {
    interface ProcessEnv {
      API_ID: string;
      API_HASH: string;
      PHONE_NUMBER: string;
    }
  }
}
export {};
