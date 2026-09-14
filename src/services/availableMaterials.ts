import { rocksMiningService, type MaterialName } from "./rocksMiningService";
import {
  computeAvailableMaterials,
  getFrozenMaterials,
  getFrozenMaterialsStatus,
  hasConfirmedFrozenMaterials,
  subscribeToFrozenMaterials,
  type FrozenMaterialsStatus,
} from "./wagerMaterialsService";

export type AvailableMaterialsSnapshot = {
  availableMaterials: Record<MaterialName, number>;
  frozenMaterialsStatus: FrozenMaterialsStatus;
  hasConfirmedSnapshot: boolean;
};

export const readAvailableMaterials = (): AvailableMaterialsSnapshot => ({
  availableMaterials: computeAvailableMaterials(
    rocksMiningService.getSnapshot().materials,
    getFrozenMaterials(),
  ),
  frozenMaterialsStatus: getFrozenMaterialsStatus(),
  hasConfirmedSnapshot: hasConfirmedFrozenMaterials(),
});

export const subscribeAvailableMaterials = (
  listener: (snapshot: AvailableMaterialsSnapshot) => void,
): (() => void) => {
  let active = false;
  const notify = () => {
    if (active) listener(readAvailableMaterials());
  };
  const unsubscribeMining = rocksMiningService.subscribe(notify);
  const unsubscribeFrozen = subscribeToFrozenMaterials(notify);
  active = true;
  notify();

  return () => {
    active = false;
    unsubscribeMining();
    unsubscribeFrozen();
  };
};
