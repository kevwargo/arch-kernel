import { Duration, RemovalPolicy } from "aws-cdk-lib";
import { KeyPair, Peer, Port, SecurityGroup, Vpc } from "aws-cdk-lib/aws-ec2";
import { Code, Function, FunctionOptions, IFunction, Runtime } from "aws-cdk-lib/aws-lambda";
import { ILogGroup, LogGroup, RetentionDays } from "aws-cdk-lib/aws-logs";
import { pascalCase } from "change-case";
import { Construct } from "constructs";
import { SFNImageBuilder, SFNImageBuilderProps } from "../sfn";

export class CustomImageProvider extends Construct {
  public readonly serviceToken: string;

  private readonly logGroup: ILogGroup;

  constructor(scope: Construct, id: string) {
    super(scope, id);

    this.logGroup = new LogGroup(this, "LogGroup", {
      removalPolicy: RemovalPolicy.RETAIN,
      retention: RetentionDays.ONE_MONTH,
    });

    const secGroup = new SecurityGroup(this, "SecurityGroup", {
      vpc: Vpc.fromLookup(this, "DefaultVpc", { isDefault: true }),
      allowAllIpv6Outbound: true,
      allowAllOutbound: true,
    });

    const sfnProps: SFNImageBuilderProps = {
      securityGroupId: secGroup.securityGroupId,
      finalizerFn: this.createFunction("finalizer"),
      logGroup: this.logGroup,
    };

    const publicKey = this.node.tryGetContext("debug-ssh-public-key");
    if (publicKey) {
      sfnProps.keyName = new KeyPair(this, "KeyPair", {
        publicKeyMaterial: publicKey,
      }).keyPairName;
      secGroup.addIngressRule(Peer.anyIpv4(), Port.SSH);
    }

    const builder = new SFNImageBuilder(this, "Builder", sfnProps);

    const starterFn = this.createFunction("starter", {
      environment: {
        STATE_MACHINE_ARN: builder.sfn.stateMachineArn,
      },
    });
    builder.sfn.grantStartExecution(starterFn);

    this.serviceToken = starterFn.functionArn;
  }

  private createFunction(handler: string, opts?: FunctionOptions): IFunction {
    return new Function(this, pascalCase(handler), {
      runtime: Runtime.PYTHON_3_13,
      code: Code.fromAsset(`${__dirname}/lambda`, {
        bundling: {
          image: Runtime.PYTHON_3_13.bundlingImage,
          command: [
            "bash",
            "-c",
            "pip install requests -t /asset-output && cp -a . /asset-output",
          ],
        },
      }),
      handler: `handler.${handler}`,
      timeout: Duration.minutes(3),
      logGroup: this.logGroup,
      ...opts,
    });
  }
}
