import { isJsonObject, type JsonObject, type JsonValue } from "@empty/module-sdk";

export const objectOf = (value: JsonValue | undefined): JsonObject =>
  isJsonObject(value) ? value : {};

export const listOf = (value: JsonValue | undefined): JsonValue[] =>
  Array.isArray(value) ? value : [];

export const textOf = (value: JsonValue | undefined): string | null =>
  typeof value === "string" ? value : null;

export const numberOf = (value: JsonValue | undefined): number | null =>
  typeof value === "number" ? value : null;
