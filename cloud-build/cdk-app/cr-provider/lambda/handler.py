import json
import os
from uuid import uuid4

import boto3
import requests

STATE_MACHINE_ARN = os.getenv("STATE_MACHINE_ARN")

sfn = boto3.client("stepfunctions")

# Event example:
# {
#    "RequestType" : "Create",
#    "RequestId" : "4880d380-40d3-4217-b78b-2afe8cab8e90",
#    "StackId" : "arn:aws:cloudformation:us-west-2:123456789012:stack/mystack/5b918d10-cd98-11ea-90d5-0a9cd3354c10",
#    "ResponseURL" : "http://pre-signed-S3-url-for-response",
#    "ResourceType" : "Custom::TestResource",
#    "LogicalResourceId" : "MyTestResource",
#    "ResourceProperties" : {
#       "Name" : "Value",
#       "List" : [ "1", "2", "3" ]
#    }
# }

# Create and Update Response
# {
#    "Status": "SUCCESS",
#    "RequestId": "unique-request-id",
#    "StackId": "arn:aws:cloudformation:us-west-2:123456789012:stack/name/id",
#    "LogicalResourceId": "resource-logical-id",
#    "PhysicalResourceId": "provider-defined-physical-id",
#    "NoEcho": true,
#    "Data": {
#       "key1": "value1",
#       "key2": "value2"
#    }
# }
# Delete Response
# {
#    "Status": "SUCCESS",
#    "RequestId": "unique-request-id",
#    "StackId": "arn:aws:cloudformation:us-west-2:123456789012:stack/name/id",
#    "LogicalResourceId": "resource-logical-id",
#    "PhysicalResourceId": "provider-defined-physical-id"
# }
# Failed Response Example
# {
#    "Status": "FAILED",
#    "RequestId": "unique-request-id",
#    "StackId": "arn:aws:cloudformation:us-west-2:123456789012:stack/name/id",
#    "LogicalResourceId": "resource-logical-id",
#    "PhysicalResourceId": "provider-defined-physical-id",
#    "Reason": "Required failure reason string"
# }


def starter(event: dict, _):
    print(json.dumps(event, default=str))
    {"Create": on_create, "Update": on_update, "Delete": on_delete}[event["RequestType"]](event)


def on_create(event: dict):
    cfn = {
        k: v
        for k, v in event.items()
        if k in ("RequestId", "StackId", "LogicalResourceId", "ResponseURL")
    }
    cfn["PhysicalResourceId"] = str(uuid4())
    props = event["ResourceProperties"]

    # this conversion is needed because CFN converts numbers to strings
    # along the way for some reason
    props["RootVolSize"] = int(props["RootVolSize"])

    sfn.start_execution(
        stateMachineArn=STATE_MACHINE_ARN,
        input=json.dumps({"cfn": cfn, "props": props}),
    )


def on_update(event: dict):
    upload_success(event)


def on_delete(event: dict):
    upload_success(event)


def upload_success(event: dict):
    data = {"Status": "SUCCESS"}
    data.update(
        (k, v)
        for k, v in event.items()
        if k in ("RequestId", "StackId", "LogicalResourceId", "PhysicalResourceId")
    )
    resp = requests.put(event["ResponseURL"], json=data)
    resp.raise_for_status()


def finalizer(event: dict, _):
    if error := event.get("error"):
        data = {"Status": "FAILED", "Reason": f'{error["Error"]!r}: {error["Cause"]}'}
    else:
        data = {"Status": "SUCCESS", "Data": {"ImageId": event["image"]["id"]}}

    url = event["cfn"].pop("ResponseURL")
    resp = requests.put(url, json=event["cfn"] | data)
    resp.raise_for_status()
