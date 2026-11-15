"use client";
import { useEffect, useState } from "react";
/** Clock changes only update local action availability; they never poll the RPC. */
export function useMarketClock() {
  const [now, setNow] = useState(() => Math.floor(Date.now() / 1000));
  useEffect(() => {
    const timer = setInterval(
      () => setNow(Math.floor(Date.now() / 1000)),
      1000,
    );
    return () => clearInterval(timer);
  }, []);
  return now;
}
