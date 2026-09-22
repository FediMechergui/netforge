/**
 * The Tables tab of the device inspector (ARCHITECTURE-P2 §6 "NAT quadrant visualizer"; W3 web-inspector): on a
 * device that translates addresses (a `nat` extra table) the inside/outside × local/global quadrant heads the generic
 * tables and follows the selected packet; every other device shows the generic tables alone. Kept apart from
 * DeviceInspector.tsx so the tab can be rendered without the rest of the inspector tree.
 */
import type { DeviceSnapshot } from '@netforge/engine';
import { hasNatTable, NatQuadrantForDevice } from './NatQuadrant';
import { TablesView, useTickNow } from './TablesView';

export function TablesTab({ device }: { device: DeviceSnapshot }) {
  const now = useTickNow();
  return (
    <>
      {hasNatTable(device) && <NatQuadrantForDevice device={device} now={now} />}
      <TablesView device={device} now={now} />
    </>
  );
}
