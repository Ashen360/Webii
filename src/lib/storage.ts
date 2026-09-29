/** localStorage that never throws (private mode, blocked storage, quota). */
export const storage = {
  get<T>(key: string, fallback: T): T {
    try {
      const raw = localStorage.getItem(`webii:${key}`);
      return raw === null ? fallback : (JSON.parse(raw) as T);
    } catch {
      return fallback;
    }
  },
  set(key: string, value: unknown): void {
    try {
      localStorage.setItem(`webii:${key}`, JSON.stringify(value));
    } catch {
      /* non-essential */
    }
  },
  remove(key: string): void {
    try {
      localStorage.removeItem(`webii:${key}`);
    } catch {
      /* non-essential */
    }
  },
};
