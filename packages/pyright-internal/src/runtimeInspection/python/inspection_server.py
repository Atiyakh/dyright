#!/usr/bin/env python3
"""
inspection_server.py

Python inspection server for runtime-augmented Pyright.
Receives serialized objects via HTTP, executes inspection scripts,
and returns formatted results.

Usage:
    python inspection_server.py [--port PORT] [--host HOST] [--scripts-dir DIR]
"""

import argparse
import asyncio
import base64
import importlib.util
import json
import logging
import os
import pickle
import resource
import signal
import sys
import threading
import traceback
import uuid
from concurrent.futures import ThreadPoolExecutor, TimeoutError
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Callable, Dict, Optional

from aiohttp import web

# Configure logging
logging.basicConfig(
    level=logging.INFO,
    format='%(asctime)s - %(name)s - %(levelname)s - %(message)s'
)
logger = logging.getLogger('inspection_server')


@dataclass
class InspectionRequest:
    """Incoming inspection request."""
    inspection_id: str
    type_name: str
    serialization: str
    payload: str
    timeout_ms: int
    resource_limits: Optional[Dict[str, Any]] = None


@dataclass
class InspectionResponse:
    """Outgoing inspection response."""
    inspection_id: str
    success: bool
    result: Optional[str] = None
    error: Optional[str] = None
    execution_time_ms: Optional[float] = None

    def to_dict(self) -> dict:
        return {
            'inspectionId': self.inspection_id,
            'success': self.success,
            'result': self.result,
            'error': self.error,
            'executionTimeMs': self.execution_time_ms,
        }


@dataclass
class InspectionScript:
    """Registered inspection script."""
    type_name: str
    script_path: Path
    inspect_fn: Optional[Callable[[Any], str]] = None
    load_error: Optional[str] = None


class InspectionRegistry:
    """Registry for type inspection scripts."""

    def __init__(self, scripts_dir: Optional[Path] = None):
        self._scripts: Dict[str, InspectionScript] = {}
        self._scripts_dir = scripts_dir or Path.cwd() / 'inspection_scripts'
        self._lock = threading.Lock()

    def register(self, type_name: str, script_path: str) -> bool:
        """Register an inspection script for a type."""
        path = Path(script_path)
        if not path.is_absolute():
            path = self._scripts_dir / path

        script = InspectionScript(type_name=type_name, script_path=path)

        # Try to load the script
        try:
            script.inspect_fn = self._load_script(path)
        except Exception as e:
            script.load_error = str(e)
            logger.error(f"Failed to load script for {type_name}: {e}")

        with self._lock:
            self._scripts[type_name] = script

        return script.inspect_fn is not None

    def _load_script(self, path: Path) -> Callable[[Any], str]:
        """Load an inspection script and return its inspect function."""
        if not path.exists():
            raise FileNotFoundError(f"Script not found: {path}")

        # Load module from file
        spec = importlib.util.spec_from_file_location(
            f"inspection_{path.stem}_{uuid.uuid4().hex[:8]}",
            path
        )
        if spec is None or spec.loader is None:
            raise ImportError(f"Cannot load spec from {path}")

        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)

        # Get the inspect function
        if not hasattr(module, 'inspect'):
            raise AttributeError(f"Script {path} does not define 'inspect' function")

        inspect_fn = getattr(module, 'inspect')
        if not callable(inspect_fn):
            raise TypeError(f"'inspect' in {path} is not callable")

        return inspect_fn

    def get(self, type_name: str) -> Optional[InspectionScript]:
        """Get the inspection script for a type."""
        with self._lock:
            # Exact match
            if type_name in self._scripts:
                return self._scripts[type_name]

            # Try normalized name (e.g., pandas.core.frame.DataFrame -> pandas.DataFrame)
            parts = type_name.split('.')
            if len(parts) > 2:
                short_name = f"{parts[0]}.{parts[-1]}"
                if short_name in self._scripts:
                    return self._scripts[short_name]

            return None

    def get_all_types(self) -> list:
        """Get all registered type names."""
        with self._lock:
            return list(self._scripts.keys())

    def reload(self, type_name: str) -> bool:
        """Reload a script for a type."""
        with self._lock:
            if type_name not in self._scripts:
                return False
            script = self._scripts[type_name]

        try:
            script.inspect_fn = self._load_script(script.script_path)
            script.load_error = None
            return True
        except Exception as e:
            script.load_error = str(e)
            logger.error(f"Failed to reload script for {type_name}: {e}")
            return False


class ResourceLimiter:
    """Applies resource limits to inspection execution."""

    def __init__(self, ram_mb: Optional[int] = None, cpu_percent: Optional[int] = None):
        self.ram_mb = ram_mb
        self.cpu_percent = cpu_percent
        self._original_limits: Dict[int, tuple] = {}

    def __enter__(self):
        """Apply resource limits."""
        if sys.platform != 'win32':  # Resource limits not available on Windows
            if self.ram_mb:
                try:
                    soft, hard = resource.getrlimit(resource.RLIMIT_AS)
                    self._original_limits[resource.RLIMIT_AS] = (soft, hard)
                    resource.setrlimit(
                        resource.RLIMIT_AS,
                        (self.ram_mb * 1024 * 1024, hard)
                    )
                except (ValueError, resource.error) as e:
                    logger.warning(f"Failed to set memory limit: {e}")
        return self

    def __exit__(self, exc_type, exc_val, exc_tb):
        """Restore original resource limits."""
        if sys.platform != 'win32':
            for limit_type, (soft, hard) in self._original_limits.items():
                try:
                    resource.setrlimit(limit_type, (soft, hard))
                except (ValueError, resource.error):
                    pass
        return False


class InspectionServer:
    """HTTP server for runtime inspections."""

    def __init__(
        self,
        host: str = 'localhost',
        port: int = 8765,
        scripts_dir: Optional[Path] = None,
        max_workers: int = 4
    ):
        self.host = host
        self.port = port
        self.registry = InspectionRegistry(scripts_dir)
        self.executor = ThreadPoolExecutor(max_workers=max_workers)
        self.app = web.Application()
        self._setup_routes()

    def _setup_routes(self):
        """Set up HTTP routes."""
        self.app.router.add_get('/health', self._handle_health)
        self.app.router.add_post('/inspect', self._handle_inspect)
        self.app.router.add_post('/register', self._handle_register)
        self.app.router.add_get('/types', self._handle_types)
        self.app.router.add_post('/shutdown', self._handle_shutdown)

    async def _handle_health(self, request: web.Request) -> web.Response:
        """Health check endpoint."""
        return web.json_response({'status': 'ok'})

    async def _handle_inspect(self, request: web.Request) -> web.Response:
        """Handle inspection request."""
        try:
            data = await request.json()
            req = InspectionRequest(
                inspection_id=data.get('inspectionId', str(uuid.uuid4())),
                type_name=data['type'],
                serialization=data['serialization'],
                payload=data['payload'],
                timeout_ms=data.get('timeoutMs', 5000),
                resource_limits=data.get('resourceLimits'),
            )

            response = await self._execute_inspection(req)
            return web.json_response(response.to_dict())

        except Exception as e:
            logger.exception("Error handling inspection request")
            return web.json_response(
                InspectionResponse(
                    inspection_id=data.get('inspectionId', 'unknown'),
                    success=False,
                    error=str(e)
                ).to_dict(),
                status=500
            )

    async def _execute_inspection(self, req: InspectionRequest) -> InspectionResponse:
        """Execute an inspection in a worker thread."""
        import time
        start_time = time.time()

        # Get inspection script
        script = self.registry.get(req.type_name)
        if script is None:
            return InspectionResponse(
                inspection_id=req.inspection_id,
                success=False,
                error=f"No inspection script registered for type: {req.type_name}"
            )

        if script.inspect_fn is None:
            return InspectionResponse(
                inspection_id=req.inspection_id,
                success=False,
                error=f"Script load error: {script.load_error}"
            )

        # Deserialize object
        try:
            if req.serialization == 'pickle':
                obj = pickle.loads(base64.b64decode(req.payload))
            elif req.serialization == 'json':
                obj = json.loads(base64.b64decode(req.payload).decode('utf-8'))
            else:
                return InspectionResponse(
                    inspection_id=req.inspection_id,
                    success=False,
                    error=f"Unknown serialization format: {req.serialization}"
                )
        except Exception as e:
            return InspectionResponse(
                inspection_id=req.inspection_id,
                success=False,
                error=f"Deserialization error: {e}"
            )

        # Execute inspection in worker thread with timeout
        timeout_sec = req.timeout_ms / 1000.0
        loop = asyncio.get_event_loop()

        def run_inspection():
            resource_limits = req.resource_limits or {}
            with ResourceLimiter(
                ram_mb=resource_limits.get('ramMb'),
                cpu_percent=resource_limits.get('cpuPercent')
            ):
                return script.inspect_fn(obj)

        try:
            result = await asyncio.wait_for(
                loop.run_in_executor(self.executor, run_inspection),
                timeout=timeout_sec
            )
            execution_time_ms = (time.time() - start_time) * 1000

            return InspectionResponse(
                inspection_id=req.inspection_id,
                success=True,
                result=str(result),
                execution_time_ms=execution_time_ms
            )

        except asyncio.TimeoutError:
            return InspectionResponse(
                inspection_id=req.inspection_id,
                success=False,
                error=f"Inspection timed out after {req.timeout_ms}ms"
            )
        except Exception as e:
            logger.exception("Inspection execution error")
            return InspectionResponse(
                inspection_id=req.inspection_id,
                success=False,
                error=f"Inspection error: {e}\n{traceback.format_exc()}"
            )

    async def _handle_register(self, request: web.Request) -> web.Response:
        """Handle script registration request."""
        try:
            data = await request.json()
            type_name = data['typeName']
            script_path = data['scriptPath']

            success = self.registry.register(type_name, script_path)
            return web.json_response({'success': success})

        except Exception as e:
            logger.exception("Error handling registration request")
            return web.json_response({'success': False, 'error': str(e)}, status=500)

    async def _handle_types(self, request: web.Request) -> web.Response:
        """List registered types."""
        return web.json_response({'types': self.registry.get_all_types()})

    async def _handle_shutdown(self, request: web.Request) -> web.Response:
        """Shutdown the server."""
        logger.info("Shutdown requested")
        asyncio.get_event_loop().call_later(0.5, self._shutdown)
        return web.json_response({'status': 'shutting_down'})

    def _shutdown(self):
        """Perform graceful shutdown."""
        self.executor.shutdown(wait=False)
        raise web.GracefulExit()

    def run(self):
        """Start the server."""
        logger.info(f"Starting inspection server on {self.host}:{self.port}")
        web.run_app(self.app, host=self.host, port=self.port, print=None)


def main():
    """Main entry point."""
    parser = argparse.ArgumentParser(description='Runtime inspection server')
    parser.add_argument('--host', default='localhost', help='Host to bind to')
    parser.add_argument('--port', type=int, default=8765, help='Port to bind to')
    parser.add_argument('--scripts-dir', type=Path, help='Directory containing inspection scripts')
    parser.add_argument('--debug', action='store_true', help='Enable debug logging')
    args = parser.parse_args()

    if args.debug:
        logging.getLogger().setLevel(logging.DEBUG)

    server = InspectionServer(
        host=args.host,
        port=args.port,
        scripts_dir=args.scripts_dir
    )

    # Register some default inspections
    scripts_dir = args.scripts_dir or Path.cwd() / 'inspection_scripts'
    if scripts_dir.exists():
        for script_file in scripts_dir.glob('*.py'):
            # Derive type name from filename (e.g., dataframe.py -> pandas.DataFrame)
            type_mapping = {
                'dataframe': 'pandas.DataFrame',
                'series': 'pandas.Series',
                'ndarray': 'numpy.ndarray',
            }
            stem = script_file.stem.lower()
            if stem in type_mapping:
                server.registry.register(type_mapping[stem], str(script_file))
                logger.info(f"Registered {type_mapping[stem]} -> {script_file}")

    server.run()


if __name__ == '__main__':
    main()
