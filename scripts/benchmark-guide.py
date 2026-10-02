"""Synthetic XMLTV scan cost, not an implementation or a live-feed benchmark."""
import io
import json
import time
import tracemalloc
import xml.etree.ElementTree as ET


class Guide(io.RawIOBase):
    def __init__(self, channels):
        self.remaining = channels * 48
        self.index = 0
        self.pending = b'<tv>'
        self.bytes = 0
        self.finished = False

    def read(self, count=-1):
        while len(self.pending) < count and not self.finished:
            if self.index == self.remaining:
                self.pending += b'</tv>'
                self.finished = True
            else:
                channel = self.index // 48
                self.pending += (f'<programme channel="{channel}" start="20260924000000 +0000" stop="20260924003000 +0000"><title>News {self.index}</title><desc>' + 'x' * 512 + '</desc></programme>').encode()
                self.index += 1
        chunk, self.pending = self.pending[:count], self.pending[count:]
        self.bytes += len(chunk)
        return chunk


def scan(channels):
    feed = Guide(channels)
    matches = []
    tracemalloc.start()
    start = time.perf_counter()
    parser = ET.iterparse(feed, events=('start', 'end'))
    _, root = next(parser)
    for event, element in parser:
        if event == 'end' and element.tag == 'programme':
            # Synthetic restricted viewer: only even channel IDs; result cap 20.
            if int(element.get('channel')) % 2 == 0 and len(matches) < 20:
                if 'news' in element.findtext('title', '').lower():
                    matches.append(element.findtext('title'))
            root.clear()
    elapsed = time.perf_counter() - start
    _, peak = tracemalloc.get_traced_memory()
    tracemalloc.stop()
    return dict(seconds=elapsed, bytes=feed.bytes, peak_traced_bytes=peak, results=len(matches))


if __name__ == '__main__':
    print(json.dumps(dict(synthetic=True, channels=5000, programs=240000,
                         candidate_bulk_requests_per_scan=1, implemented_upstream_requests=0,
                         cold=scan(5000), warm=scan(5000)), indent=2))
