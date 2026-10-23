import { Elysia } from "elysia";

// ─── Dashboard ───────────────────────────────────────────────────
// GET /dashboard — static page. It holds no data itself: it asks for the
// API key in the browser and then talks to /api/v1/groups/invite/*
// (with the key in a header), so the key never appears in a URL.
//
// The page derives its base path from where it is served, so it also works
// behind a reverse proxy that mounts it under a prefix (e.g. /wagate/).
// ─────────────────────────────────────────────────────────────────

const page = Bun.file(new URL("./dashboard.html", import.meta.url));

export const dashboard = new Elysia()
  // "/" -> "dashboard" (relative, so it also works behind a prefix like /wagate/)
  .get(
    "/",
    () => new Response(null, { status: 302, headers: { location: "dashboard" } }),
    { detail: { hide: true } },
  )
  .get(
    "/dashboard",
    ({ set }) => {
      set.headers["content-type"] = "text/html; charset=utf-8";
      set.headers["cache-control"] = "no-store";
      return page;
    },
    { detail: { hide: true } },
  );
