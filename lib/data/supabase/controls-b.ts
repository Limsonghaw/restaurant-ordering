import { DataError, type LiveMockAction, type LiveMockSettings } from "../types";
function missing(): never { throw new DataError("NOT_IMPLEMENTED", "未实现"); }
export async function getLiveMockSettings(): Promise<LiveMockSettings> { return missing(); }
export async function configureLiveMock(_patch: Partial<LiveMockSettings>): Promise<void> { return missing(); }
export async function runLiveMockAction(_action: LiveMockAction): Promise<void> { return missing(); }
