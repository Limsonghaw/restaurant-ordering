import { DataError, type MockAction, type MockSettings, type MockSnapshot } from '../types';
export async function getMockSnapshot(): Promise<MockSnapshot> { throw new DataError('NOT_IMPLEMENTED', '未实现'); }
export async function configureMock(_settings: Partial<MockSettings>): Promise<void> { throw new DataError('NOT_IMPLEMENTED', '未实现'); }
export async function runMockAction(_action: MockAction, _code: string): Promise<void> { throw new DataError('NOT_IMPLEMENTED', '未实现'); }
