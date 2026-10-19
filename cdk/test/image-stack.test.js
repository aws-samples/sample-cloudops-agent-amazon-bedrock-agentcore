"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
const fs = __importStar(require("fs"));
const os = __importStar(require("os"));
const path = __importStar(require("path"));
const aws_cdk_lib_1 = require("aws-cdk-lib");
const image_stack_1 = require("../lib/image-stack");
// Source.asset stages through FileSystem.copyDirectory with the same exclude
// options, so this is exactly what BucketDeployment would upload.
test('source assets drop local build artifacts at any depth, including dotfiles inside them', () => {
    const src = fs.mkdtempSync(path.join(os.tmpdir(), 'asset-src-'));
    const dest = fs.mkdtempSync(path.join(os.tmpdir(), 'asset-dest-'));
    const files = [
        'main.py',
        'tests/test_main.py',
        '.venv/.gitignore',
        '.venv/lib/site.py',
        'node_modules/pkg/index.js',
        '__pycache__/main.cpython-312.pyc',
        'tests/__pycache__/test_main.cpython-312.pyc',
        '.pytest_cache/.gitignore',
        '.hypothesis/examples/x',
        'tests/stray.pyc',
    ];
    for (const f of files) {
        fs.mkdirSync(path.dirname(path.join(src, f)), { recursive: true });
        fs.writeFileSync(path.join(src, f), '');
    }
    aws_cdk_lib_1.FileSystem.copyDirectory(src, dest, { exclude: image_stack_1.LOCAL_ARTIFACTS });
    const copied = fs.readdirSync(dest, { recursive: true });
    expect(copied.filter((f) => fs.statSync(path.join(dest, f)).isFile()).sort())
        .toEqual(['main.py', path.join('tests', 'test_main.py')]);
});
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoiaW1hZ2Utc3RhY2sudGVzdC5qcyIsInNvdXJjZVJvb3QiOiIiLCJzb3VyY2VzIjpbImltYWdlLXN0YWNrLnRlc3QudHMiXSwibmFtZXMiOltdLCJtYXBwaW5ncyI6Ijs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7QUFBQSx1Q0FBeUI7QUFDekIsdUNBQXlCO0FBQ3pCLDJDQUE2QjtBQUM3Qiw2Q0FBeUM7QUFDekMsb0RBQXFEO0FBRXJELDZFQUE2RTtBQUM3RSxrRUFBa0U7QUFDbEUsSUFBSSxDQUFDLHVGQUF1RixFQUFFLEdBQUcsRUFBRTtJQUNqRyxNQUFNLEdBQUcsR0FBRyxFQUFFLENBQUMsV0FBVyxDQUFDLElBQUksQ0FBQyxJQUFJLENBQUMsRUFBRSxDQUFDLE1BQU0sRUFBRSxFQUFFLFlBQVksQ0FBQyxDQUFDLENBQUM7SUFDakUsTUFBTSxJQUFJLEdBQUcsRUFBRSxDQUFDLFdBQVcsQ0FBQyxJQUFJLENBQUMsSUFBSSxDQUFDLEVBQUUsQ0FBQyxNQUFNLEVBQUUsRUFBRSxhQUFhLENBQUMsQ0FBQyxDQUFDO0lBQ25FLE1BQU0sS0FBSyxHQUFHO1FBQ1osU0FBUztRQUNULG9CQUFvQjtRQUNwQixrQkFBa0I7UUFDbEIsbUJBQW1CO1FBQ25CLDJCQUEyQjtRQUMzQixrQ0FBa0M7UUFDbEMsNkNBQTZDO1FBQzdDLDBCQUEwQjtRQUMxQix3QkFBd0I7UUFDeEIsaUJBQWlCO0tBQ2xCLENBQUM7SUFDRixLQUFLLE1BQU0sQ0FBQyxJQUFJLEtBQUssRUFBRSxDQUFDO1FBQ3RCLEVBQUUsQ0FBQyxTQUFTLENBQUMsSUFBSSxDQUFDLE9BQU8sQ0FBQyxJQUFJLENBQUMsSUFBSSxDQUFDLEdBQUcsRUFBRSxDQUFDLENBQUMsQ0FBQyxFQUFFLEVBQUUsU0FBUyxFQUFFLElBQUksRUFBRSxDQUFDLENBQUM7UUFDbkUsRUFBRSxDQUFDLGFBQWEsQ0FBQyxJQUFJLENBQUMsSUFBSSxDQUFDLEdBQUcsRUFBRSxDQUFDLENBQUMsRUFBRSxFQUFFLENBQUMsQ0FBQztJQUMxQyxDQUFDO0lBRUQsd0JBQVUsQ0FBQyxhQUFhLENBQUMsR0FBRyxFQUFFLElBQUksRUFBRSxFQUFFLE9BQU8sRUFBRSw2QkFBZSxFQUFFLENBQUMsQ0FBQztJQUVsRSxNQUFNLE1BQU0sR0FBRyxFQUFFLENBQUMsV0FBVyxDQUFDLElBQUksRUFBRSxFQUFFLFNBQVMsRUFBRSxJQUFJLEVBQUUsQ0FBYSxDQUFDO0lBQ3JFLE1BQU0sQ0FBQyxNQUFNLENBQUMsTUFBTSxDQUFDLENBQUMsQ0FBQyxFQUFFLEVBQUUsQ0FBQyxFQUFFLENBQUMsUUFBUSxDQUFDLElBQUksQ0FBQyxJQUFJLENBQUMsSUFBSSxFQUFFLENBQUMsQ0FBQyxDQUFDLENBQUMsTUFBTSxFQUFFLENBQUMsQ0FBQyxJQUFJLEVBQUUsQ0FBQztTQUMxRSxPQUFPLENBQUMsQ0FBQyxTQUFTLEVBQUUsSUFBSSxDQUFDLElBQUksQ0FBQyxPQUFPLEVBQUUsY0FBYyxDQUFDLENBQUMsQ0FBQyxDQUFDO0FBQzlELENBQUMsQ0FBQyxDQUFDIiwic291cmNlc0NvbnRlbnQiOlsiaW1wb3J0ICogYXMgZnMgZnJvbSAnZnMnO1xuaW1wb3J0ICogYXMgb3MgZnJvbSAnb3MnO1xuaW1wb3J0ICogYXMgcGF0aCBmcm9tICdwYXRoJztcbmltcG9ydCB7IEZpbGVTeXN0ZW0gfSBmcm9tICdhd3MtY2RrLWxpYic7XG5pbXBvcnQgeyBMT0NBTF9BUlRJRkFDVFMgfSBmcm9tICcuLi9saWIvaW1hZ2Utc3RhY2snO1xuXG4vLyBTb3VyY2UuYXNzZXQgc3RhZ2VzIHRocm91Z2ggRmlsZVN5c3RlbS5jb3B5RGlyZWN0b3J5IHdpdGggdGhlIHNhbWUgZXhjbHVkZVxuLy8gb3B0aW9ucywgc28gdGhpcyBpcyBleGFjdGx5IHdoYXQgQnVja2V0RGVwbG95bWVudCB3b3VsZCB1cGxvYWQuXG50ZXN0KCdzb3VyY2UgYXNzZXRzIGRyb3AgbG9jYWwgYnVpbGQgYXJ0aWZhY3RzIGF0IGFueSBkZXB0aCwgaW5jbHVkaW5nIGRvdGZpbGVzIGluc2lkZSB0aGVtJywgKCkgPT4ge1xuICBjb25zdCBzcmMgPSBmcy5ta2R0ZW1wU3luYyhwYXRoLmpvaW4ob3MudG1wZGlyKCksICdhc3NldC1zcmMtJykpO1xuICBjb25zdCBkZXN0ID0gZnMubWtkdGVtcFN5bmMocGF0aC5qb2luKG9zLnRtcGRpcigpLCAnYXNzZXQtZGVzdC0nKSk7XG4gIGNvbnN0IGZpbGVzID0gW1xuICAgICdtYWluLnB5JyxcbiAgICAndGVzdHMvdGVzdF9tYWluLnB5JyxcbiAgICAnLnZlbnYvLmdpdGlnbm9yZScsXG4gICAgJy52ZW52L2xpYi9zaXRlLnB5JyxcbiAgICAnbm9kZV9tb2R1bGVzL3BrZy9pbmRleC5qcycsXG4gICAgJ19fcHljYWNoZV9fL21haW4uY3B5dGhvbi0zMTIucHljJyxcbiAgICAndGVzdHMvX19weWNhY2hlX18vdGVzdF9tYWluLmNweXRob24tMzEyLnB5YycsXG4gICAgJy5weXRlc3RfY2FjaGUvLmdpdGlnbm9yZScsXG4gICAgJy5oeXBvdGhlc2lzL2V4YW1wbGVzL3gnLFxuICAgICd0ZXN0cy9zdHJheS5weWMnLFxuICBdO1xuICBmb3IgKGNvbnN0IGYgb2YgZmlsZXMpIHtcbiAgICBmcy5ta2RpclN5bmMocGF0aC5kaXJuYW1lKHBhdGguam9pbihzcmMsIGYpKSwgeyByZWN1cnNpdmU6IHRydWUgfSk7XG4gICAgZnMud3JpdGVGaWxlU3luYyhwYXRoLmpvaW4oc3JjLCBmKSwgJycpO1xuICB9XG5cbiAgRmlsZVN5c3RlbS5jb3B5RGlyZWN0b3J5KHNyYywgZGVzdCwgeyBleGNsdWRlOiBMT0NBTF9BUlRJRkFDVFMgfSk7XG5cbiAgY29uc3QgY29waWVkID0gZnMucmVhZGRpclN5bmMoZGVzdCwgeyByZWN1cnNpdmU6IHRydWUgfSkgYXMgc3RyaW5nW107XG4gIGV4cGVjdChjb3BpZWQuZmlsdGVyKChmKSA9PiBmcy5zdGF0U3luYyhwYXRoLmpvaW4oZGVzdCwgZikpLmlzRmlsZSgpKS5zb3J0KCkpXG4gICAgLnRvRXF1YWwoWydtYWluLnB5JywgcGF0aC5qb2luKCd0ZXN0cycsICd0ZXN0X21haW4ucHknKV0pO1xufSk7XG4iXX0=