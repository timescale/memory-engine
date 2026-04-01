Bun.serve({
  port: process.env.PORT || 3000,
  fetch() {
    return new Response("memory engine");
  },
});
