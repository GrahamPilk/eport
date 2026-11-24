import { defineCollection } from 'astro:content';
import { glob } from 'astro/loaders';
import { z } from 'astro/zod';

const blog = defineCollection({
  loader: glob({ pattern: '**/*.md', base: './src/content/blog' }),
  schema: z.object({
    title: z.string(),
    description: z.string().default(''),
    date: z.coerce.date(),
    updated: z.coerce.date().optional(),
    tags: z.array(z.string()).default([]),
    draft: z.boolean().default(false),
  }),
});

const work = defineCollection({
  loader: glob({ pattern: '**/*.md', base: './src/content/work' }),
  schema: z.object({
    title: z.string(),
    year: z.union([z.string(), z.number()]).transform(String),
    role: z.string(),
    summary: z.string(),
    stack: z.array(z.string()).default([]),
    url: z.string().url().optional(),
    repo: z.string().url().optional(),
    order: z.number().default(100),
    featured: z.boolean().default(true),
  }),
});

export const collections = { blog, work };
