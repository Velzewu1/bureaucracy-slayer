import { z } from "zod";

export const IdSchema = z.string().regex(/^[a-z]+_[a-zA-Z0-9_-]{6,}$/);
export const IsoDateTimeSchema = z.string().datetime();
export const HttpUrlSchema = z
  .string()
  .url()
  .refine((url) => url.startsWith("http://") || url.startsWith("https://"), "Expected an HTTP(S) URL");
export const JsonScalarSchema = z.union([z.string(), z.number().finite(), z.boolean()]);
export const FactKeySchema = z.string().regex(/^[a-z][a-zA-Z0-9_.-]*$/);
export const HashSchema = z.string().min(8);

export type JsonScalar = z.infer<typeof JsonScalarSchema>;

