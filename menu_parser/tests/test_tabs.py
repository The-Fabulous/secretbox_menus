"""Offline checks: python -m unittest discover -s menu_parser/tests -v"""
import contextlib
import copy
import io
import json
import os
from pathlib import Path
import sys
import tempfile
import types
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import driver


class TabTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(dir=Path(__file__).resolve().parent)
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.site = self.root / 'coffee-menu'
        self.here = self.root / 'menu_parser'
        self.source = self.root / 'venues' / 'coffee_house'
        for path in (self.site / 'data', self.here, self.source):
            path.mkdir(parents=True)
        driver.write_json(self.site / 'data' / 'categories.json', {'categories': [
            {'id': 'coffee', 'name': 'Кофе', 'emoji': '☕'}]})
        driver.write_json(self.here / 'etalon.json', {})
        driver.write_json(self.source / 'cafe.json', {'name': 'Coffee House', 'logo': 'logo.png'})
        (self.source / 'logo.png').write_bytes(b'logo fixture')
        (self.source / 'menu.jpg').write_bytes(b'menu fixture')
        self.tab = self.site / 'tabs' / 'coffee_house'
        self.response = {'categories': [{'id': 'coffee', 'name': 'Кофе'}], 'items': [
            {'name': 'Латте', 'category_id': 'coffee', 'variants': [{'price': 1200, 'measure': '300 мл'}]}]}
        self.enterContext(patch.object(driver, 'SITE', self.site))
        self.enterContext(patch.object(driver, 'HERE', self.here))
        self.enterContext(patch.dict(os.environ, {'OPENAI_API_KEY': 'offline-test'}))
        self.enterContext(patch.dict(sys.modules, {'openai': types.SimpleNamespace(OpenAI=lambda **kw: object())}))

    def run_driver(self, *args, failure=None, response=None):
        data = self.response if response is None else response
        with patch.object(sys, 'argv', ['driver.py', str(self.source), '--no-photos', *args]), \
                patch.object(driver, 'image_tiles', return_value=[(None, 'fixture')]) as tiles, \
                patch.object(driver, 'ask_model', side_effect=failure, return_value=(data, json.dumps(data))), \
                contextlib.redirect_stdout(io.StringIO()):
            driver.main()
        return tiles

    def snapshot(self):
        return {p.relative_to(self.tab): p.read_bytes() for p in self.tab.rglob('*') if p.is_file()}

    def test_default_creates_complete_tab_and_updates_without_duplicate(self):
        tiles = self.run_driver()
        self.assertEqual([call.args[0].name for call in tiles.call_args_list], ['menu.jpg'])
        self.assertEqual((self.tab / 'logo.png').read_bytes(), b'logo fixture')
        self.assertTrue((self.tab / 'raw' / 'menu.jpg.json').exists())
        self.assertEqual(driver.load_json(self.tab / 'cafe.json')['name'], 'Coffee House')
        driver.write_json(self.source / 'cafe.json', {'name': 'New name', 'city': 'Алматы'})
        self.run_driver()
        self.assertEqual(driver.load_json(self.site / 'tabs' / 'index.json')['tabs'], ['coffee_house'])
        self.assertEqual(driver.load_json(self.tab / 'cafe.json')['name'], 'New name')
        self.assertEqual(driver.load_json(self.tab / 'cafe.json')['logo'], 'logo.png')

    def test_custom_output_is_complete_and_not_registered(self):
        folder = self.root / 'preview' / 'coffee_house'
        self.run_driver('--out', str(folder))
        self.assertTrue((folder / 'menu.json').exists())
        self.assertTrue((folder / 'cafe.json').exists())
        self.assertTrue((folder / 'logo.png').exists())
        self.assertFalse((self.site / 'tabs' / 'index.json').exists())

    def test_manual_tab_preserved_with_complete_copy(self):
        self.run_driver()
        cafe = driver.load_json(self.tab / 'cafe.json')
        cafe.pop('source')
        driver.write_json(self.tab / 'cafe.json', cafe)
        before = self.snapshot()
        self.run_driver('--publish')
        self.assertEqual(before, self.snapshot())
        preview = self.here / 'output' / 'tabs' / 'coffee_house'
        self.assertTrue((preview / 'menu.json').exists())
        self.assertTrue((preview / 'logo.png').exists())

    def test_failed_fragment_preserves_previous_tab(self):
        self.run_driver()
        before = self.snapshot()
        (self.source / 'second.jpg').write_bytes(b'second page')
        with self.assertRaises(SystemExit):
            self.run_driver(failure=[(copy.deepcopy(self.response), '{}'), RuntimeError('offline failure')])
        self.assertEqual(before, self.snapshot())

    def test_empty_menu_preserves_previous_tab(self):
        self.run_driver()
        before = self.snapshot()
        with self.assertRaises(SystemExit):
            self.run_driver(response={'items': []})
        self.assertEqual(before, self.snapshot())

    def test_image_paths_stay_inside_movable_bundle(self):
        class Crop:
            def thumbnail(self, size):
                pass

            def save(self, path, *args, **kwargs):
                Path(path).write_bytes(b'image fixture')

        menu = {'categories': [], 'items': [{'id': 'item_latte', 'image_url': None}]}
        driver.write_tab(self.tab, 'coffee_house', {'name': 'Coffee House'}, menu,
                         {'item_latte': Crop()}, {})
        item = driver.load_json(self.tab / 'menu.json')['items'][0]
        self.assertEqual(item['image_url'], 'images/item_latte.jpg')
        self.assertEqual((self.tab / item['image_url']).read_bytes(), b'image fixture')


if __name__ == '__main__':
    unittest.main()
