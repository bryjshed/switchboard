import { useCallback, useRef, useState } from 'react';

/**
 * RefreshControl state that tracks the USER'S pull, not the query's fetch flags.
 * Binding the spinner to isFetching/isRefetching makes every background
 * refetch spin the control (and on iOS it can stick); this owns the flag and
 * clears it when the refetch settles, ignoring a second pull mid-flight.
 */
export function usePullToRefresh(refetch: () => Promise<unknown>) {
  const [refreshing, setRefreshing] = useState(false);
  const inFlight = useRef(false);

  const onRefresh = useCallback(() => {
    if (inFlight.current) return;
    inFlight.current = true;
    setRefreshing(true);
    void refetch()
      .catch(() => {
        // The query's own error state renders the failure; nothing to add here.
      })
      .finally(() => {
        inFlight.current = false;
        setRefreshing(false);
      });
  }, [refetch]);

  return { refreshing, onRefresh };
}
