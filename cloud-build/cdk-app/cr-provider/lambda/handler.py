import json
import os
from datetime import UTC, datetime
from uuid import uuid4

import boto3
import requests

STATE_MACHINE_ARN = os.getenv("STATE_MACHINE_ARN")
RESOURCE_TAG_KEY = os.getenv("RESOURCE_TAG_KEY")

sfn = boto3.client("stepfunctions")
ec2 = boto3.client("ec2")


def starter(cfn_event: dict, _):
    log("Handling CFN request", event=cfn_event)

    try:
        req = cfn_event["RequestType"]
        if req == "Create":
            handle_create(cfn_event)
        elif req == "Update":
            handle_update(cfn_event)
        elif req == "Delete":
            handle_delete(cfn_event)
        else:
            raise ValueError(f"Invalid CFN request type {req!r}")
    except Exception as e:
        upload_response(cfn_event, error=f"{type(e).__name__}: {e}")


def handle_create(cfn_event: dict):
    cfn = {
        k: v
        for k, v in cfn_event.items()
        if k in ("RequestId", "StackId", "LogicalResourceId", "ResponseURL")
    }
    cfn["PhysicalResourceId"] = str(uuid4())

    props = cfn_event["ResourceProperties"]
    # CFN converts numbers to strings along the way for some reason
    props["RootVolSize"] = int(props["RootVolSize"])

    sfn.start_execution(
        stateMachineArn=STATE_MACHINE_ARN,
        input=json.dumps({"cfn": cfn, "props": props}),
    )


def handle_update(cfn_event: dict):
    images = find_images(cfn_event)
    if not images:
        raise ValueError(
            f'EC2 image with tags {RESOURCE_TAG_KEY}={cfn_event["PhysicalResourceId"]} not found'
        )
    if len(images) > 1:
        raise ValueError(
            f'Multiple EC2 images with tags {RESOURCE_TAG_KEY}={cfn_event["PhysicalResourceId"]}: '
            + ", ".join(i["ImageId"] for i in images)
        )

    upload_response(cfn_event, data={"ImageId": images[0]["ImageId"]})


def handle_delete(cfn_event: dict):
    for img in find_images(cfn_event):
        log("Deregistering image", image=img)
        resp = ec2.deregister_image(
            ImageId=img["ImageId"],
            DeleteAssociatedSnapshots=True,
        )
        log("Image deregistered", resp=resp)

    upload_response(cfn_event)


def find_images(cfn_event: dict):
    return (
        ec2.describe_images(
            Filters=[
                {"Name": f"tag:{RESOURCE_TAG_KEY}", "Values": [cfn_event["PhysicalResourceId"]]}
            ]
        ).get("Images")
        or []
    )


def finalizer(event: dict, _):
    cfn_event = event["cfn"]
    if error := event.get("error"):
        upload_response(cfn_event, error=f'{error["Error"]!r}: {error["Cause"]}')
    else:
        upload_response(cfn_event, data={"ImageId": event["image"]["id"]})


def upload_response(
    cfn_event: dict,
    *,
    error: str | None = None,
    data: dict | None = None,
    new_id: str | None = None,
):
    payload = dict(cfn_event)
    url = payload.pop("ResponseURL")
    if error is not None:
        payload["Status"] = "FAILED"
        payload["Reason"] = error
    else:
        payload["Status"] = "SUCCESS"

    if data is not None:
        payload["Data"] = data

    if new_id is not None:
        payload["PhysicalResourceId"] = new_id

    log("Uploading CFN response", url=url, payload=payload)

    resp = requests.put(url, json=payload)
    resp.raise_for_status()


def log(msg: str, **fields):
    print(json.dumps({"msg": msg, "time": datetime.now(UTC), **fields}, default=str))
