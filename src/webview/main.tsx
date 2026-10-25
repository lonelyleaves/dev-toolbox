import { h, render } from 'preact';
import { App } from './app';
import { notifyReady } from './bridge';
import './styles.css';
import '@vscode/codicons/dist/codicon.css';

render(<App />, document.getElementById('root')!);
notifyReady();
