import { QueryClient } from "@tanstack/react-query";
import { createRouter } from "@tanstack/react-router";
import { setupRouterSsrQueryIntegration } from "@tanstack/react-router-ssr-query";
import { routeTree } from "./routeTree.gen";

function PendingScreen() {
  return (
    <div className="flex min-h-screen items-center justify-center bg-background">
      <div className="size-5 rounded-full border-2 border-muted-foreground/30 border-t-foreground/60 animate-spin" />
    </div>
  );
}

export const getRouter = () => {
  const queryClient = new QueryClient();

  const router = createRouter({
    routeTree,
    context: { queryClient },
    scrollRestoration: true,
    defaultPreloadStaleTime: 0,
    defaultPendingComponent: PendingScreen,
    defaultPendingMs: 300,
    defaultPendingMinMs: 150,
  });

  // Dehydrates the queryClient into the SSR payload and rehydrates it on the
  // client before first paint, so server-rendered data (from `ensureQueryData`
  // in route loaders) matches the client's initial render instead of the
  // client starting from a cold cache and mismatching on hydration.
  setupRouterSsrQueryIntegration({ router, queryClient });

  return router;
};
