import importlib.util
from pathlib import Path


def test_seed_demo_data_module_has_main_and_parser():
    script_path = Path(__file__).resolve().parents[1] / "scripts" / "seed_demo_data.py"
    spec = importlib.util.spec_from_file_location("seed_demo_data", script_path)
    assert spec and spec.loader
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    assert callable(module.main)
    assert callable(module.parse_args)


def test_seed_demo_document_is_a_valid_pdf():
    script_path = Path(__file__).resolve().parents[1] / "scripts" / "seed_demo_data.py"
    spec = importlib.util.spec_from_file_location("seed_demo_data_pdf", script_path)
    assert spec and spec.loader
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)

    data = module.build_demo_pdf("Client Details PDF")

    assert data.startswith(b"%PDF-")
    assert data.rstrip().endswith(b"%%EOF")
    assert b"/Type /Page" in data
