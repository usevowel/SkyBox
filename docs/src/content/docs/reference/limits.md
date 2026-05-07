---
title: Limits & Constraints
description: Cloudflare Workers and Durable Object hard limits.
---

| Constraint | Value | Notes |
|-----------|-------|-------|
| Max WS per DO | 32,768 | Hard limit from Hibernation API |
| Memory per DO | 128 MB | Shared between VM + connections |
| DO storage ops | 1,000/sec | Limit `storage.put()` calls |
| WS message size | 1 MB | Hard limit from Workers |
| Attachment size | 2,048 bytes | `serializeAttachment` limit |
| CPU per request | 30s (paid) / 10s (free) | DO message handler timeout |
| DO creations | 128 per 10s | Per account soft limit |
