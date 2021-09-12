#!/bin/sh

if [ "$1" -eq "latest" ]
then
  curl -fsSL https://dprint.dev/install.sh | sh > /dev/null 2>&1
else
  curl -fsSL https://dprint.dev/install.sh | sh -s $0 > /dev/null 2>&1
fi
