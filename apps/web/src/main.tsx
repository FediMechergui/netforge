/**
 * Entry point: apply the persisted theme, start the engine worker, then mount
 * the app inside an error boundary.
 */
import { Component, StrictMode, type ErrorInfo, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { App } from './app/App';
import { initEngine } from './bridge/client';
import { applyThemeAttribute, store } from './store/store';
import './styles.css';

interface BoundaryState {
  error: Error | null;
}

/** Error boundaries must be class components; this is the only class in the shell. */
class ErrorBoundary extends Component<{ children: ReactNode }, BoundaryState> {
  override state: BoundaryState = { error: null };

  static getDerivedStateFromError(error: Error): BoundaryState {
    return { error };
  }

  override componentDidCatch(error: Error, info: ErrorInfo): void {
    console.error('NetForge UI fault', error, info.componentStack);
  }

  override render(): ReactNode {
    if (this.state.error) return <Fatal error={this.state.error} />;
    return this.props.children;
  }
}

function Fatal({ error }: { error: unknown }) {
  const message = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
  const stack = error instanceof Error && error.stack ? error.stack : '';
  return (
    <div className="fatal" role="alert">
      <h1>The workbench hit a snag it could not recover from.</h1>
      <p>
        Nothing you built is lost on the engine side, but this view must reload. Copy the details below if you want
        to report the problem.
      </p>
      <pre>
        {message}
        {stack ? `\n\n${stack}` : ''}
      </pre>
      <button type="button" className="btn btn-primary" onClick={() => location.reload()}>
        Reload the page
      </button>
    </div>
  );
}

function Boot({ text }: { text: string }) {
  return (
    <div className="boot">
      <div className="spinner" aria-hidden="true" />
      <div>{text}</div>
    </div>
  );
}

function mount(): void {
  const el = document.getElementById('root');
  if (!el) throw new Error('#root is missing from index.html');
  applyThemeAttribute(store.getState().theme);
  const root: Root = createRoot(el);
  root.render(<Boot text="Starting the simulation engine…" />);

  initEngine()
    .then(() => {
      root.render(
        <StrictMode>
          <ErrorBoundary>
            <App />
          </ErrorBoundary>
        </StrictMode>,
      );
    })
    .catch((err: unknown) => {
      root.render(<Fatal error={err} />);
    });
}

mount();
