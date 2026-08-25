declare module '*.vue' {
  import type { DefineComponent } from 'vue';

  const component: DefineComponent<Record<string, never>, Record<string, never>, unknown>;
  export default component;
}

// Side-effect asset imports (main.ts's `import './styles/main.css'`) need an
// ambient module declaration too, or tsc/vue-tsc fails the build on the
// first `--ui` scaffold typecheck (TS2882-class "cannot find module").
declare module '*.css';
