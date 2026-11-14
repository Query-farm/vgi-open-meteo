"""Execute fresh kernels, saving each notebook atomically only after success."""
from __future__ import annotations
import argparse
import ast
import json
import os
from pathlib import Path
import re
import shutil
import sys
from tempfile import TemporaryDirectory
from time import monotonic
import nbformat
from jupyter_client import KernelManager
from jupyter_client.kernelspec import KernelSpecManager
from nbclient import NotebookClient


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('notebooks', nargs='*', type=Path)
    parser.add_argument('--parameters', default='{}', help='JSON overrides; requires a separate output directory.')
    parser.add_argument('--output-dir', type=Path)
    parser.add_argument('--timeout', type=int, default=180)
    args = parser.parse_args()
    directory = Path(__file__).resolve().parent
    overrides = json.loads(args.parameters)
    if not isinstance(overrides, dict):
        parser.error('--parameters must be a JSON object')
    if overrides and not args.output_dir:
        parser.error('Parameter overrides require --output-dir to protect the saved default.')
    paths = [p.resolve() for p in (args.notebooks or sorted(directory.glob('[0-9][0-9]_*.ipynb')))]
    destination_dir = args.output_dir.resolve() if args.output_dir else None
    if overrides and any(destination_dir / p.name == p for p in paths):
        parser.error('Overrides must use a destination separate from every source notebook.')
    if overrides and destination_dir == directory:
        parser.error('Override copies cannot replace the canonical examples.')
    os.environ['PLOOMBER_STATS_ENABLED'] = 'false'
    with TemporaryDirectory(prefix='open-meteo-notebook-') as temporary:
        kernel_dir = Path(temporary) / 'weather-examples'
        kernel_dir.mkdir()
        (kernel_dir / 'kernel.json').write_text(json.dumps({
            'argv': [sys.executable, '-m', 'ipykernel_launcher', '-f', '{connection_file}'],
            'display_name': 'Python (vgi-open-meteo notebooks)', 'language': 'python'}))
        for path in paths:
            notebook = nbformat.read(path, as_version=4)
            parameter_cell = next(c for c in notebook.cells if 'parameters' in c.metadata.get('tags', []))
            names = {n.targets[0].id for n in ast.parse(parameter_cell.source).body
                     if isinstance(n, ast.Assign) and isinstance(n.targets[0], ast.Name)}
            if unknown := overrides.keys() - names:
                raise ValueError(f'Unknown parameters: {sorted(unknown)}')
            for key, value in overrides.items():
                parameter_cell.source = re.sub(rf'^{re.escape(key)}\s*=.*$',
                    lambda _, k=key, v=value: f'{k} = {v!r}', parameter_cell.source, flags=re.MULTILINE)
            manager = KernelManager(kernel_name='weather-examples',
                kernel_spec_manager=KernelSpecManager(kernel_dirs=[temporary]))
            print(f'Running {path.name} ...', flush=True)
            started = monotonic()
            try:
                NotebookClient(notebook, km=manager, timeout=args.timeout, allow_errors=False,
                    resources={'metadata': {'path': str(directory)}}).execute(cleanup_kc=True)
            except Exception:
                print(f'FAILED: {path.name}; saved outputs unchanged.', flush=True)
                raise
            nbformat.validate(notebook)
            destination = destination_dir / path.name if destination_dir else path
            destination.parent.mkdir(parents=True, exist_ok=True)
            if destination_dir and destination_dir != directory:
                shutil.copytree(directory / 'assets', destination_dir / 'assets', dirs_exist_ok=True)
                for companion in ('README.md', 'STANDARD.md', 'github_worker.ts', 'notebook_support.py', 'execute.py', 'pyproject.toml', 'uv.lock'):
                    shutil.copy2(directory / companion, destination_dir / companion)
            staging = destination.with_suffix('.ipynb.tmp')
            nbformat.write(notebook, staging)
            staging.replace(destination)
            charts = sum('image/png' in o.get('data', {}) for c in notebook.cells
                         if c.cell_type == 'code' for o in c.outputs)
            print(f'OK: {destination}; {charts} charts; {monotonic()-started:.1f}s', flush=True)

if __name__ == '__main__':
    main()
