import { useEffect, useState } from "react";
import {
  readAvailableMaterials,
  subscribeAvailableMaterials,
} from "../services/availableMaterials";

export const useAvailableMaterials = () => {
  const [snapshot, setSnapshot] = useState(readAvailableMaterials);
  useEffect(() => subscribeAvailableMaterials(setSnapshot), []);
  return snapshot;
};
