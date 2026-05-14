"use client";

import { useEffect } from "react";
import { ServiceWorkerRegister } from "@/components/ServiceWorkerRegister";
import { useStore } from "@/stores/useStore";

export function AppBootstrap() {
  const hydrate = useStore((state) => state.hydrate);

  useEffect(() => {
    hydrate();
  }, [hydrate]);

  return <ServiceWorkerRegister />;
}
