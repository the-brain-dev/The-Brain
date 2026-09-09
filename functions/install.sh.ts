/**
 * Keep the removed installer endpoint retired even if an older Pages asset
 * remains in an edge cache.
 */
export function onRequest() {
  return new Response("Not Found", {
    status: 404,
    headers: {
      "Cache-Control": "no-store",
    },
  });
}
