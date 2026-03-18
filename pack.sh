#!/bin/bash
set -e
npm run compile
vsce package
