import { AsyncLocalStorage } from "node:async_hooks";

export const customerHyperdriveConnection = new AsyncLocalStorage<string>();
