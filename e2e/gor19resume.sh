#!/bin/bash
# Mac-only wrapper for run019resume.mjs. B is the harness base dir on the test Mac.
B=/Users/aw/aw-e2e-v017
export PATH=$B/node/bin:$PATH
rm -rf $B/run19x $B/home19x; mkdir -p $B/run19x $B/home19x; : > $B/run19x/mock.jsonl
cd $B/harness
node mock-backend.mjs 8455 cert.pem key.pem $B/run19x/mock.jsonl > $B/run19x/mock.out 2>&1 &
MP=$!
sleep 2
HOME=$B/home19x NODE_TLS_REJECT_UNAUTHORIZED=0 timeout 900 node run019resume.mjs "$B/app019/AW Desktop.app" "$B/run19x" 8455 > $B/run19x/out.txt 2>&1
echo EXIT $? >> $B/run19x/out.txt
kill $MP 2>/dev/null
