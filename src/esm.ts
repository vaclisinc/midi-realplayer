import { resolveAssetBase } from "./asset-base";
import { defineElement, setDefaultAssetBase } from "./midi-realplayer";

declare const __MRP_VERSION__: string;

setDefaultAssetBase(resolveAssetBase(import.meta.url, __MRP_VERSION__));
defineElement();

export * from "./midi-realplayer";

declare global {
  interface HTMLElementTagNameMap {
    "midi-realplayer": import("./midi-realplayer").MidiRealPlayerElement;
  }
}
