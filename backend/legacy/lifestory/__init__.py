"""Life Story — guided biographical interview + biography writer (ported from Bio-per3).

How it connects to the rest of Digital Legacy:

* Family-added recordings (audio or text) are analysed after ingestion: they mark
  questions on the 80-question coverage map and open follow-up threads, so the
  interviewer never asks about what the family already told it.
* Each interview session, when ended, is saved as a recording. The normal
  ingestion pipeline turns it into memories, so the voice conversation can use it.
* The biography writer draws on interview transcripts AND family memories.
"""
