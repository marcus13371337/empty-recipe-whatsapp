import type { JsonObject, JsonValue } from "@empty/module-sdk";

export const isObject = (value: JsonValue | undefined): value is JsonObject =>
  typeof value === "object" && value !== null && !Array.isArray(value);

export const objectOf = (value: JsonValue | undefined): JsonObject =>
  isObject(value) ? value : {};

export const listOf = (value: JsonValue | undefined): JsonValue[] =>
  Array.isArray(value) ? value : [];

export const textOf = (value: JsonValue | undefined): string | null =>
  typeof value === "string" ? value : null;

export const numberOf = (value: JsonValue | undefined): number | null =>
  typeof value === "number" ? value : null;
