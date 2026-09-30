import { resolveAssetBase } from "./asset-base";
import { defineElement, setDefaultAssetBase } from "./midi-realplayer";

declare const __MRP_VERSION__: string;

const script = document.currentScript as HTMLScriptElement | null;
setDefaultAssetBase(resolveAssetBase(script?.src, __MRP_VERSION__));
defineElement();

export * from "./midi-realplayer";
