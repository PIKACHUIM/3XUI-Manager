export interface ListOptions {
  limit?: number;
  cursor?: string | null;
  prefix?: string;
}

export interface Page<T> {
  items: T[];
  cursor: string | null;
}

export interface DocumentStore {
  get<T>(collection: string, id: string): Promise<T | null>;
  put<T>(collection: string, id: string, value: T): Promise<void>;
  delete(collection: string, id: string): Promise<void>;
  list<T>(collection: string, options?: ListOptions): Promise<Page<T>>;
  has(collection: string, id: string): Promise<boolean>;
  acquireLease(name: string, owner: string, expiresAt: number): Promise<boolean>;
  releaseLease(name: string, owner: string): Promise<void>;
}

export class StorageUnavailableError extends Error {
  constructor(driver: string) {
    super(`Storage binding is not configured for driver "${driver}".`);
    this.name = "StorageUnavailableError";
  }
}
