export type UnknownRecord = Record<string, unknown>

export function isRecord(x: unknown): x is UnknownRecord {
  return typeof x === 'object' && x !== null && !Array.isArray(x)
}

export function hasOwn(x: object, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(x, key)
}

export function isString(x: unknown): x is string {
  return typeof x === 'string'
}

export function isNumber(x: unknown): x is number {
  return typeof x === 'number' && Number.isFinite(x)
}

export function isErrorCode(x: unknown): boolean {
  return isString(x) || isNumber(x)
}

export function isErrorMessage(x: unknown): boolean {
  return isRecord(x) && isErrorCode(x.code) && isString(x.message)
}
