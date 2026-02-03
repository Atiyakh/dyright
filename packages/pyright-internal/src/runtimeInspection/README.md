# Runtime-Augmented Pyright for Jupyter Notebooks

This module extends Pyright's static type analysis with controlled dynamic inspection of live kernel objects. It provides rich hover information for notebook environments by combining static type inference with runtime introspection.

## Architecture

```
┌─────────────────────────────────────────────────────────────────────────┐
│                           Process Topology                               │
├─────────────────────────────────────────────────────────────────────────┤
│                                                                          │
│   ┌──────────┐         ┌──────────────────────────────────────────────┐ │
│   │  Editor  │────────▶│              LSP Server (Node.js)            │ │
│   │ (VS Code)│         │  ┌─────────────────────────────────────────┐ │ │
│   └──────────┘         │  │        RuntimeInspectionService         │ │ │
│        │               │  │  • ConfigLoader   • KernelClient        │ │ │
│        │ Hover         │  │  • InspectionClient                     │ │ │
│        │ Request       │  └─────────────────────────────────────────┘ │ │
│        ▼               │         │                    │               │ │
│   ┌──────────┐         │         │ ZMQ                │ HTTP          │ │
│   │  Static  │         │         ▼                    ▼               │ │
│   │ Analysis │◀────────│   ┌──────────┐     ┌───────────────────┐    │ │
│   └──────────┘         │   │  Kernel  │     │ Inspection Server │    │ │
│                        │   │ (Python) │────▶│    (Python)       │    │ │
│                        │   └──────────┘     │  • Safe sandbox   │    │ │
│                        │        │           │  • Custom scripts │    │ │
│                        │        │ Pickle/   └───────────────────┘    │ │
│                        │        │ Shallow                            │ │
│                        │        │ Copy                               │ │
│                        │        ▼                                    │ │
│                        │   ┌──────────────────────────────────────┐  │ │
│                        │   │        Serialized Object Copy        │  │ │
│                        │   └──────────────────────────────────────┘  │ │
│                        └──────────────────────────────────────────────┘ │
└─────────────────────────────────────────────────────────────────────────┘
```

## Components

### TypeScript Components (LSP Server)

1. **`types.ts`** - Core type definitions
   - `LspContextConfig` - Main configuration schema
   - `TypeInspectionConfig` - Per-type inspection settings
   - `RuntimeInspectionResult` - Result from inspection

2. **`configLoader.ts`** - Configuration management
   - Loads `lspContext.json` from workspace
   - Validates configuration
   - Watches for changes

3. **`kernelClient.ts`** - Jupyter kernel communication
   - ZMQ-based protocol (optional zeromq dependency)
   - Type validation in kernel
   - Object serialization

4. **`inspectionClient.ts`** - HTTP client for inspection server
   - Sends serialized objects for inspection
   - Handles responses and errors

5. **`runtimeInspectionService.ts`** - Main orchestration
   - Entry point: `inspectForHover(expression, staticType)`
   - Coordinates all components
   - Produces hover-ready results

6. **`runtimeAwareHoverProvider.ts`** - Extended hover provider
   - Combines static + runtime analysis
   - Graceful fallback on errors

### Python Components (Inspection Server)

1. **`inspection_server.py`** - HTTP server for inspection
   - Receives serialized objects
   - Executes inspection scripts
   - Resource limiting

2. **`inspection_scripts/`** - Per-type inspection logic
   - `dataframe.py` - pandas DataFrame inspection
   - `series.py` - pandas Series inspection
   - `ndarray.py` - numpy array inspection

## Configuration

Create `lspContext.json` in your workspace:

```json
{
    "enabled": true,
    "kernel": {
        "connectionFile": "/path/to/connection.json"
    },
    "inspectionServer": {
        "port": 8765,
        "host": "localhost"
    },
    "typeInspections": {
        "pandas.DataFrame": {
            "maxSizeMb": 50,
            "timeoutMs": 2000,
            "copyStrategy": {
                "mode": "shallow",
                "maxDepth": 1
            },
            "inspectionCode": "./inspection_scripts/dataframe.py",
            "resourceLimits": {
                "ramMb": 256,
                "cpuPercent": 50
            }
        }
    }
}
```

### Configuration Options

| Field | Type | Description |
|-------|------|-------------|
| `enabled` | boolean | Enable/disable runtime inspection |
| `debug` | boolean | Enable debug logging |
| `kernel.connectionFile` | string | Path to Jupyter connection file |
| `inspectionServer.port` | number | Inspection server port |
| `typeInspections` | object | Per-type inspection configs |

### Type Inspection Options

| Field | Type | Description |
|-------|------|-------------|
| `maxSizeMb` | number | Maximum object size for inspection |
| `timeoutMs` | number | Timeout for inspection |
| `copyStrategy.mode` | string | `shallow`, `deep`, or `pickle` |
| `inspectionCode` | string | Path to inspection script |
| `resourceLimits` | object | RAM and CPU limits |

## Writing Inspection Scripts

Each inspection script must define an `inspect(obj)` function that returns a string:

```python
def inspect(obj):
    """
    Inspect an object and return a human-readable string.
    
    Args:
        obj: The deserialized object to inspect
        
    Returns:
        A string representation suitable for hover display
    """
    lines = []
    lines.append(f"Shape: {obj.shape}")
    lines.append(f"Columns: {list(obj.columns)}")
    lines.append(f"Memory: {obj.memory_usage().sum() / 1024:.1f} KB")
    return "\n".join(lines)
```

## Integration Points

### Using NotebookServer

```typescript
import { createNotebookServer } from './notebookServer';

const server = createNotebookServer(connection, maxWorkers, fs, {
    workspaceRoot: '/path/to/workspace',
    enableRuntimeInspection: true,
    inspectionTimeoutMs: 3000,
});

await server.waitForInitialization();
```

### Custom Integration

```typescript
import { getRuntimeInspectionService } from './runtimeInspection';

// Get the service
const service = getRuntimeInspectionService('/path/to/workspace');

// Initialize
await service.initialize();

// Use in hover provider
if (service.isAvailable() && service.hasTypeConfig(staticType)) {
    const result = await service.inspectForHover(expression, staticType);
    // Use result.dynamicResult
}
```

## Safety Guarantees

1. **Memory Protection**
   - Size checks before serialization
   - Configurable limits per type

2. **CPU Protection**
   - Timeouts on all operations
   - Resource limits in inspection server

3. **Isolation**
   - Shallow copies prevent kernel modification
   - Separate inspection process
   - Sandboxed execution

4. **Graceful Degradation**
   - Falls back to static analysis on any error
   - Non-blocking design
   - Timeout protection

## Future Enhancements

- [ ] Streaming for large objects
- [ ] Caching of inspection results
- [ ] Custom visualization renderers
- [ ] Multi-kernel support
- [ ] Remote kernel connections
