/// <reference types="vite/client" />
/// <reference types="vite-plugin-pwa/client" />

interface Object {
  [key: string]: any;
}

interface Error {
  [key: string]: any;
}

interface Navigator {
  gpu?: any;
  deviceMemory?: number;
  standalone?: boolean;
  windowControlsOverlay?: any;
  userLanguage?: string;
}

interface Window {
  [key: string]: any;
}

declare namespace React {
  function useState(initialState?: null | undefined | (() => null | undefined)): [any, React.Dispatch<React.SetStateAction<any>>];
  function useState(initialState: any[] | (() => any[])): [any[], React.Dispatch<React.SetStateAction<any[]>>];
  function useRef(initialValue?: null | undefined): React.MutableRefObject<any>;
  function useRef(initialValue: any[]): React.MutableRefObject<any[]>;
  function createContext(defaultValue?: null | undefined): React.Context<any>;
}


