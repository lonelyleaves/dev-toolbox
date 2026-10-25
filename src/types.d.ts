declare module 'cronstrue/i18n' {
  import cronstrue from 'cronstrue';
  export = cronstrue;
}

declare module 'jsqr' {
  interface QRCodeResult {
    data: string;
    binaryData: number[];
    chunks: unknown[];
    version: number;
  }
  function jsQR(data: Uint8ClampedArray, width: number, height: number): QRCodeResult | null;
  export = jsQR;
}

declare module 'mssql';
declare module 'oracledb';
