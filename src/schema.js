// Tiny helpers for JSON Schemas compatible with Claude structured outputs.
export const str = { type: 'string' };
export const int = { type: 'integer' };
export const arr = (items) => ({ type: 'array', items });
export const obj = (properties) => ({ type: 'object', properties, required: Object.keys(properties), additionalProperties: false });
